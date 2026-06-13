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

let cache: CacheEntry | null = null;
let generation = 0;

function isCacheValid(profile: string): boolean {
  if (!cache) return false;
  if (cache.profile !== profile) return false;
  return (Date.now() - cache.timestamp) < CACHE_TTL_MS;
}

/**
 * Look up the given profile in the active credential store and cache
 * the result. Subsequent calls within CACHE_TTL_MS short-circuit.
 * After TTL expires, credentials are re-read from the keychain.
 * Swallows all errors.
 *
 * A generation counter guards against the race where clearPrimedCredentials()
 * fires while store.get() is still in flight — if the generation changed, we
 * discard the stale result instead of overwriting the now-empty cache.
 */
export async function primeCredentials(profile: string): Promise<void> {
  if (isCacheValid(profile)) return;
  const gen = generation;
  try {
    const store = await selectCredentialStore();
    const creds = await store.get(profile);
    if (generation !== gen) return;
    cache = { profile, creds, timestamp: Date.now() };
  } catch {
    if (generation !== gen) return;
    cache = { profile, creds: null, timestamp: Date.now() };
  }
}

/**
 * Sync accessor for code paths that cannot be made async. Returns
 * null when the cache is empty or keyed against a different profile,
 * so existing file-based fallback stays the authoritative source.
 */
export function getPrimedCredentials(profile: string): CredentialBundle | null {
  if (!cache) return null;
  if (cache.profile !== profile) return null;
  return cache.creds;
}

/**
 * Test helper. Not used by production code.
 */
export function __resetPrimedCredentials(): void {
  generation++;
  cache = null;
}

/**
 * Production helper — called by auth and config commands after saving new
 * credentials to ensure the 5-second priming cache does not serve stale
 * token/secret from the previous account.
 */
export function clearPrimedCredentials(): void {
  generation++;
  cache = null;
}
