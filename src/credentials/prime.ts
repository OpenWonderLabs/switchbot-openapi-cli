/**
 * Credential priming cache with TTL.
 *
 * `loadConfig()` runs synchronously, but every OS keychain backend is
 * async (subprocess-based). We bridge the two by priming credentials
 * once per command, early in the `preAction` hook, and keeping the
 * result in a tiny in-process cache keyed by credential storage scope.
 *
 * Auth/config commands publish a revision that invalidates other processes
 * immediately. The TTL also picks up external keychain edits without restart.
 *
 * After priming, sync callers can consult `getPrimedCredentials()` to
 * pick up keychain-stored token/secret without any await.
 *
 * A flaky keychain probe falls back to the existing config-file path.
 * Account changes during an asynchronous lookup instead fail closed.
 */

import { CredentialBundle, selectCredentialStore } from './keychain.js';
import { getConfigPath } from '../utils/flags.js';
import { assertCredentialScope, readCredentialScope, type CredentialScope } from './scope.js';

const CACHE_TTL_MS = 5_000;

export class KeychainCredentialsUnavailableError extends Error {
  constructor() {
    super('Changed credentials are unavailable from the keychain; unlock the credential store and retry.');
    this.name = 'KeychainCredentialsUnavailableError';
  }
}

interface CacheEntry {
  revision: string;
  creds: CredentialBundle | null;
  timestamp: number;
}

const caches = new Map<string, CacheEntry>();
const generations = new Map<string, number>();
const inFlight = new Map<string, { revision: string; promise: Promise<void> }>();

function isCacheValid(scope: CredentialScope): boolean {
  const entry = caches.get(scope.key);
  return entry?.revision === scope.revision && (Date.now() - entry.timestamp) < CACHE_TTL_MS;
}

function genFor(key: string): number {
  return generations.get(key) ?? 0;
}

/**
 * Look up the given profile in the active credential store and cache
 * the result. Subsequent calls within CACHE_TTL_MS short-circuit.
 * After TTL expires, credentials are re-read from the keychain.
 * Swallows store errors, but rejects a concurrent credential replacement.
 *
 * A per-scope generation counter guards against the race where
 * clearPrimedCredentials(profile) fires while store.get() is still in
 * flight — if the generation changed, we discard the stale result instead
 * of overwriting the now-empty cache.
 */
async function refreshCredentials(profile: string, scope: CredentialScope): Promise<void> {
  if (!generations.has(scope.key)) generations.set(scope.key, 0);
  const gen = genFor(scope.key);
  let creds: CredentialBundle | null = null;
  let nativeStore = false;
  try {
    const store = await selectCredentialStore();
    nativeStore = store.name !== 'file';
    creds = await store.get(profile);
  } catch {
    // Preserve file fallback for unavailable credential stores.
  }
  assertCredentialScope(scope, profile);
  if (genFor(scope.key) !== gen) return;
  if (scope.requireKeychain && (!nativeStore || !creds)) {
    throw new KeychainCredentialsUnavailableError();
  }
  caches.set(scope.key, { revision: scope.revision, creds, timestamp: Date.now() });
}

export async function primeCredentials(profile: string): Promise<void> {
  // Complete env credentials and explicit config files never wait for keychain.
  if ((process.env.SWITCHBOT_TOKEN && process.env.SWITCHBOT_SECRET) || getConfigPath()) return;
  const scope = readCredentialScope(profile);
  if (isCacheValid(scope)) return;
  const existing = inFlight.get(scope.key);
  if (existing?.revision === scope.revision) return existing.promise;

  const refresh = refreshCredentials(profile, scope);
  inFlight.set(scope.key, { revision: scope.revision, promise: refresh });
  try {
    await refresh;
  } finally {
    if (inFlight.get(scope.key)?.promise === refresh) inFlight.delete(scope.key);
  }
}

/**
 * Sync accessor for code paths that cannot be made async. Returns
 * null when the cache is empty or belongs to an obsolete credential scope,
 * so existing file-based fallback stays the authoritative source.
 * Values are a snapshot; expiry is enforced only by the asynchronous priming path.
 */
export function getPrimedCredentials(profile: string): CredentialBundle | null {
  if (getConfigPath()) return null;
  const scope = readCredentialScope(profile);
  const entry = caches.get(scope.key);
  if (scope.requireKeychain && (entry?.revision !== scope.revision || !entry.creds)) {
    throw new KeychainCredentialsUnavailableError();
  }
  return entry?.revision === scope.revision ? entry.creds : null;
}

/**
 * Test helper. Invalidates all cached and in-flight credential generations.
 */
export function __resetPrimedCredentials(): void {
  for (const p of generations.keys()) {
    generations.set(p, (generations.get(p) ?? 0) + 1);
  }
  caches.clear();
  inFlight.clear();
}

/**
 * Production helper — called by auth and config commands after saving new
 * credentials to ensure the 5-second priming cache does not serve stale
 * token/secret from the previous account.
 *
 * Pass a specific `profile` to evict only that profile's entry (preferred
 * for auth operations on a single profile). Omit to clear all profiles.
 */
export function clearPrimedCredentials(profile?: string, scope?: CredentialScope): void {
  if (profile !== undefined) {
    const key = (scope ?? readCredentialScope(profile)).key;
    generations.set(key, genFor(key) + 1);
    caches.delete(key);
    inFlight.delete(key);
  } else {
    // Iterate generations.keys() rather than caches.keys() so profiles that
    // are currently in-flight (primeCredentials awaiting store.get()) also
    // get their generation bumped, preventing the stale-write race.
    for (const p of generations.keys()) {
      generations.set(p, (generations.get(p) ?? 0) + 1);
    }
    caches.clear();
    inFlight.clear();
  }
}
