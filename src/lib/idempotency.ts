/**
 * In-memory LRU cache for idempotent request deduplication.
 * Caches the outcome of a keyed operation for 60 seconds;
 * duplicate keys within the window return the cached result (with a
 * `replayed: true` marker). Duplicate keys within the window for a DIFFERENT
 * (command, parameter) shape raise {@link IdempotencyConflictError}.
 *
 * Keys are stored in-memory as a SHA-256 fingerprint of the user-provided
 * key — the original string never touches the Map keys, so a later heap dump
 * or inadvertent log capture does not leak the raw token.
 *
 * Eviction is true LRU: each cache hit moves the entry to the back of the
 * Map's insertion-order so the oldest-unused entry is always at the front.
 *
 * Process-local only — not shared across replicas.
 */

import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 60000; // 60 seconds
const DEFAULT_MAX_ENTRIES = 1024;

export class IdempotencyConflictError extends Error {
  constructor(
    message: string,
    public readonly key: string,
    public readonly existingShape: string,
    public readonly newShape: string,
  ) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function fingerprintIdempotencyKey(key: string): string {
  return hashKey(key).slice(0, 12);
}

// Sentinel for undefined — JSON.stringify never emits a raw NUL byte, so this
// string cannot be confused with any serialised value.
const UNDEFINED_SENTINEL = '\x00undefined\x00';

function sortedJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  // Sort top-level keys for canonical representation. Parameters passed to
  // SwitchBot commands are shallow objects, so one level is sufficient.
  const sorted = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  );
  return JSON.stringify(sorted);
}

function shapeSignature(command: string, parameter: unknown): string {
  let parm: string;
  if (parameter === undefined) {
    parm = UNDEFINED_SENTINEL;
  } else {
    try {
      parm = sortedJsonStringify(parameter);
    } catch {
      parm = String(parameter);
    }
  }
  return `${command}::${parm}`;
}

export class IdempotencyCache {
  private cache = new Map<string, { result: unknown; expiresAt: number; shape: string; profile?: string }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs?: number, maxEntries?: number) {
    this.ttlMs = ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * Execute fn if the key is not cached, or return the cached result if it is.
   * On new execution, caches the result for ttlMs.
   *
   * When `shape` is provided, a cached hit is validated against the original
   * (command, parameter) fingerprint; mismatched shape raises
   * {@link IdempotencyConflictError}.
   *
   * `profile` tags the entry so {@link clearForProfile} can evict only the
   * entries belonging to a specific credential profile. Callers that omit
   * `profile` store in an unscoped bucket — those entries survive
   * {@link clearForProfile} by design; always pass the active profile for
   * any call that should be evicted on credential rotation.
   *
   * Returns a tuple-esque object with `replayed: true` when the cached
   * result is served. The `result` field is the original cached value.
   */
  async run<T>(
    key: string | undefined,
    fn: () => Promise<T>,
    shape?: { command: string; parameter: unknown },
    profile?: string,
  ): Promise<{ result: T; replayed: boolean }> {
    if (key === undefined || key === null) {
      const result = await fn();
      return { result, replayed: false };
    }

    // Use NUL-separated encoding to prevent collisions when a profile name
    // contains ':' (e.g. profile="abc:123", key="def" must not hash the same
    // as profile="abc", key="123:def").
    const hashed = hashKey(profile ? `${profile}\x00${key}` : key);
    const now = Date.now();
    const cached = this.cache.get(hashed);
    const currentShape = shape ? shapeSignature(shape.command, shape.parameter) : '*';

    if (cached && cached.expiresAt > now) {
      if (shape && cached.shape !== '*' && cached.shape !== currentShape) {
        throw new IdempotencyConflictError(
          `idempotency_conflict: key was first used for ${cached.shape.replace('::', ' ')}; refusing new shape ${currentShape.replace('::', ' ')}`,
          '<redacted>',
          cached.shape,
          currentShape,
        );
      }
      // Move to back of Map insertion order so the front stays the LRU victim.
      this.cache.delete(hashed);
      this.cache.set(hashed, cached);
      return { result: cached.result as T, replayed: true };
    }

    const result = await fn();

    if (this.cache.size >= this.maxEntries) {
      const toRemove = Math.ceil(this.maxEntries * 0.1);
      let removed = 0;
      for (const [k, v] of this.cache.entries()) {
        if (removed >= toRemove) break;
        if (v.expiresAt <= now) {
          this.cache.delete(k);
          removed++;
        }
      }
      if (this.cache.size >= this.maxEntries) {
        const lruKey = this.cache.keys().next().value;
        if (lruKey) this.cache.delete(lruKey);
      }
    }

    this.cache.set(hashed, { result, expiresAt: now + this.ttlMs, shape: currentShape, profile });
    return { result, replayed: false };
  }

  /** Remove all cached entries that were stored under the given profile. */
  clearForProfile(profile: string): void {
    for (const [k, v] of this.cache.entries()) {
      if (v.profile === profile) this.cache.delete(k);
    }
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

export const idempotencyCache = new IdempotencyCache();
