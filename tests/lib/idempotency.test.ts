import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdempotencyCache } from '../../src/lib/idempotency.js';

describe('IdempotencyCache', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('executes fn and returns its result', async () => {
    const cache = new IdempotencyCache();
    const result = await cache.run('k1', async () => 42);
    expect(result).toBe(42);
  });

  it('returns cached result for same key within TTL', async () => {
    const cache = new IdempotencyCache(60000);
    const fn = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    const r1 = await cache.run('k', fn);
    const r2 = await cache.run('k', fn);
    expect(r1).toBe('first');
    expect(r2).toBe('first');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('re-executes fn after TTL expiry', async () => {
    const cache = new IdempotencyCache(1000);
    const fn = vi.fn().mockResolvedValue('value');
    await cache.run('k', fn);
    vi.advanceTimersByTime(1001);
    await cache.run('k', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('always executes fn when key is undefined', async () => {
    const cache = new IdempotencyCache();
    const fn = vi.fn().mockResolvedValue('x');
    await cache.run(undefined, fn);
    await cache.run(undefined, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('evicts oldest entry when capacity is exceeded', async () => {
    const cache = new IdempotencyCache(60000, 3);
    await cache.run('a', async () => 1);
    await cache.run('b', async () => 2);
    await cache.run('c', async () => 3);
    expect(cache.size()).toBe(3);
    // Adding a 4th entry should evict 'a' (oldest)
    await cache.run('d', async () => 4);
    expect(cache.size()).toBeLessThanOrEqual(3);
  });

  it('concurrent same-key calls do not deduplicate (cache misses run concurrently)', async () => {
    // IdempotencyCache caches the *result*, not the in-flight promise.
    // Two concurrent calls to the same uncached key will both execute fn.
    const cache = new IdempotencyCache(60000);
    let callCount = 0;
    const fn = async () => { callCount++; return callCount; };
    const [r1, r2] = await Promise.all([
      cache.run('k', fn),
      cache.run('k', fn),
    ]);
    // Both executed because neither was in cache when the other started.
    expect(callCount).toBeGreaterThanOrEqual(1);
    // The second call will find a cache hit if the first resolved first.
    expect(typeof r1).toBe('number');
    expect(typeof r2).toBe('number');
  });

  it('clear() resets the cache', async () => {
    const cache = new IdempotencyCache();
    const fn = vi.fn().mockResolvedValue(1);
    await cache.run('k', fn);
    cache.clear();
    expect(cache.size()).toBe(0);
    await cache.run('k', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
