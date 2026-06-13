/**
 * Credential priming cache with TTL.
 *
 * `loadConfig()` runs synchronously, but every OS keychain backend is
 * async (subprocess-based). We bridge the two by priming credentials
 * once per command, early in the `preAction` hook, and keeping the
 * result in a tiny in-process cache keyed by profile name.
 *
 * For long-running processes (MCP server, daemon, status-sync), the
 * cache expires after CACHE_TTL_MS so that keychain changes (e.g. from
 * a concurrent `switchbot auth login`) are picked up without restart.
 *
 * After priming, sync callers can consult `getPrimedCredentials()` to
 * pick up keychain-stored token/secret without any await.
 *
 * This module intentionally swallows errors — a flaky keychain
 * probe must never block the CLI from running. When the probe fails
 * we behave as "nothing primed" and the existing file path is used.
 */

import { CredentialBundle, selectCredentialStore } from './keychain.js';

const CACHE_TTL_MS = 5_000;

interface CacheEntry {
  profile: string;
  creds: CredentialBundle | null;
  timestamp: number;
}

const caches = new Map<string, CacheEntry>();
const generations = new Map<string, number>();

function isCacheValid(profile: string): boolean {
  const entry = caches.get(profile);
  if (!entry) return false;
  return (Date.now() - entry.timestamp) < CACHE_TTL_MS;
}

function genFor(profile: string): number {
  return generations.get(profile) ?? 0;
}

/**
 * Look up the given profile in the active credential store and cache
 * the result. Subsequent calls within CACHE_TTL_MS short-circuit.
 * After TTL expires, credentials are re-read from the keychain.
 * Swallows all errors.
 *
 * A per-profile generation counter guards against the race where
 * clearPrimedCredentials(profile) fires while store.get() is still in
 * flight — if the generation changed, we discard the stale result instead
 * of overwriting the now-empty cache.
 */
export async function primeCredentials(profile: string): Promise<void> {
  if (isCacheValid(profile)) return;
  const gen = genFor(profile);
  try {
    const store = await selectCredentialStore();
    const creds = await store.get(profile);
    if (genFor(profile) !== gen) return;
    caches.set(profile, { profile, creds, timestamp: Date.now() });
  } catch {
    if (genFor(profile) !== gen) return;
    caches.set(profile, { profile, creds: null, timestamp: Date.now() });
  }
}

/**
 * Sync accessor for code paths that cannot be made async. Returns
 * null when the cache is empty or keyed against a different profile,
 * so existing file-based fallback stays the authoritative source.
 */
export function getPrimedCredentials(profile: string): CredentialBundle | null {
  return caches.get(profile)?.creds ?? null;
}

/**
 * Test helper. Not used by production code.
 */
export function __resetPrimedCredentials(): void {
  for (const p of caches.keys()) {
    generations.set(p, (generations.get(p) ?? 0) + 1);
  }
  caches.clear();
}

/**
 * Production helper — called by auth and config commands after saving new
 * credentials to ensure the 5-second priming cache does not serve stale
 * token/secret from the previous account.
 *
 * Pass a specific `profile` to evict only that profile's entry (preferred
 * for auth operations on a single profile). Omit to clear all profiles.
 */
export function clearPrimedCredentials(profile?: string): void {
  if (profile !== undefined) {
    generations.set(profile, (generations.get(profile) ?? 0) + 1);
    caches.delete(profile);
  } else {
    for (const p of caches.keys()) {
      generations.set(p, (generations.get(p) ?? 0) + 1);
    }
    caches.clear();
  }
}
