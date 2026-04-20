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

function shapeSignature(command: string, parameter: unknown): string {
  // Canonical-ish JSON — stable enough for object equality with no nested sort
  // (callers can pass primitives or small objects).
  let parm: string;
  try {
    parm = JSON.stringify(parameter ?? 'default');
  } catch {
    parm = String(parameter);
  }
  return `${command}::${parm}`;
}

export class IdempotencyCache {
  private cache = new Map<string, { result: unknown; expiresAt: number; shape: string }>();
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
   * Returns a tuple-esque object with `replayed: true` when the cached
   * result is served. The `result` field is the original cached value.
   */
  async run<T>(
    key: string | undefined,
    fn: () => Promise<T>,
    shape?: { command: string; parameter: unknown },
  ): Promise<{ result: T; replayed: boolean }> {
    if (!key) {
      const result = await fn();
      return { result, replayed: false };
    }

    const hashed = hashKey(key);
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
        const firstKey = this.cache.keys().next().value;
        if (firstKey) this.cache.delete(firstKey);
      }
    }

    this.cache.set(hashed, { result, expiresAt: now + this.ttlMs, shape: currentShape });
    return { result, replayed: false };
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

export const idempotencyCache = new IdempotencyCache();
