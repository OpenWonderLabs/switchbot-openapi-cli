/**
 * Credential priming cache.
 *
 * `loadConfig()` runs synchronously, but every OS keychain backend is
 * async (subprocess-based). We bridge the two by priming credentials
 * once per command, early in the `preAction` hook, and keeping the
 * result in a tiny in-process cache keyed by profile name.
 *
 * After priming, sync callers can consult `getPrimedCredentials()` to
 * pick up keychain-stored token/secret without any await.
 *
 * This module intentionally swallows errors — a flaky keychain
 * probe must never block the CLI from running. When the probe fails
 * we behave as "nothing primed" and the existing file path is used.
 */

import { CredentialBundle, selectCredentialStore } from './keychain.js';

interface CacheEntry {
  profile: string;
  creds: CredentialBundle | null;
}

let cache: CacheEntry | null = null;

/**
 * Look up the given profile in the active credential store and cache
 * the result. Safe to call multiple times — subsequent calls with the
 * same profile short-circuit against the cache. Swallows all errors.
 */
export async function primeCredentials(profile: string): Promise<void> {
  if (cache?.profile === profile) return;
  try {
    const store = await selectCredentialStore();
    const creds = await store.get(profile);
    cache = { profile, creds };
  } catch {
    cache = { profile, creds: null };
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
  cache = null;
}
