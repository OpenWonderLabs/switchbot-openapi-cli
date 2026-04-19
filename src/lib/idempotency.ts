/**
 * In-memory LRU cache for idempotent request deduplication.
 * Caches the outcome of a keyed operation for 60 seconds;
 * duplicate keys within the window return the cached result without re-executing.
 * Process-local only — not shared across replicas.
 */

const DEFAULT_TTL_MS = 60000; // 60 seconds
const DEFAULT_MAX_ENTRIES = 1024;

export class IdempotencyCache {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs?: number, maxEntries?: number) {
    this.ttlMs = ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * Execute fn if the key is not cached, or return the cached result if it is.
   * On new execution, caches the result for ttlMs.
   */
  async run<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
    // No key = always execute (not cached)
    if (!key) {
      return fn();
    }

    const now = Date.now();
    const cached = this.cache.get(key);

    // Cached and not expired
    if (cached && cached.expiresAt > now) {
      return cached.result as T;
    }

    // Expired or uncached: execute
    const result = await fn();

    // Prune if over capacity (LRU: remove oldest entries)
    if (this.cache.size >= this.maxEntries) {
      const toRemove = Math.ceil(this.maxEntries * 0.1); // Remove 10%
      let removed = 0;
      for (const [k, v] of this.cache.entries()) {
        if (removed >= toRemove) break;
        // Remove expired entries first, then oldest
        if (v.expiresAt <= now) {
          this.cache.delete(k);
          removed++;
        }
      }
      // If still over capacity, remove oldest insertion (Map is insertion-ordered)
      if (this.cache.size >= this.maxEntries) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) this.cache.delete(firstKey);
      }
    }

    // Cache the result
    this.cache.set(key, { result, expiresAt: now + this.ttlMs });

    return result;
  }

  /**
   * Clear all cached entries (mainly for testing).
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Return the number of cached entries.
   */
  size(): number {
    return this.cache.size;
  }
}

// Global shared instance for the process
export const idempotencyCache = new IdempotencyCache();
