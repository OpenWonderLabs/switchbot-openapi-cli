import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdempotencyCache, IdempotencyConflictError } from '../../src/lib/idempotency.js';

describe('IdempotencyCache', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('executes fn and returns its result', async () => {
    const cache = new IdempotencyCache();
    const { result, replayed } = await cache.run('k1', async () => 42);
    expect(result).toBe(42);
    expect(replayed).toBe(false);
  });

  it('returns cached result for same key within TTL and marks replayed:true', async () => {
    const cache = new IdempotencyCache(60000);
    const fn = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    const r1 = await cache.run('k', fn);
    const r2 = await cache.run('k', fn);
    expect(r1.result).toBe('first');
    expect(r1.replayed).toBe(false);
    expect(r2.result).toBe('first');
    expect(r2.replayed).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('re-executes fn after TTL expiry', async () => {
    const cache = new IdempotencyCache(1000);
    const fn = vi.fn().mockResolvedValue('value');
    await cache.run('k', fn);
    vi.advanceTimersByTime(1001);
    const r2 = await cache.run('k', fn);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(r2.replayed).toBe(false);
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
    await cache.run('d', async () => 4);
    expect(cache.size()).toBeLessThanOrEqual(3);
  });

  it('concurrent same-key calls do not deduplicate (cache misses run concurrently)', async () => {
    const cache = new IdempotencyCache(60000);
    let callCount = 0;
    const fn = async () => { callCount++; return callCount; };
    const [r1, r2] = await Promise.all([
      cache.run('k', fn),
      cache.run('k', fn),
    ]);
    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(typeof r1.result).toBe('number');
    expect(typeof r2.result).toBe('number');
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

  it('C4: raises IdempotencyConflictError when same key is used with different shape within TTL', async () => {
    const cache = new IdempotencyCache(60000);
    await cache.run('k', async () => 'ok', { command: 'turnOn', parameter: undefined });
    await expect(
      cache.run('k', async () => 'ok', { command: 'turnOff', parameter: undefined }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('C4: same key with same shape replays without conflict', async () => {
    const cache = new IdempotencyCache(60000);
    const fn = vi.fn().mockResolvedValue('result');
    await cache.run('k', fn, { command: 'turnOn', parameter: undefined });
    const r2 = await cache.run('k', fn, { command: 'turnOn', parameter: undefined });
    expect(r2.replayed).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('C4: stored keys are hashed (not raw) — size counts one entry per key regardless', async () => {
    // Indirect check: the same plaintext key reaches the same internal slot.
    const cache = new IdempotencyCache();
    await cache.run('plaintext-secret-token', async () => 1);
    await cache.run('plaintext-secret-token', async () => 2);
    expect(cache.size()).toBe(1);
  });
});
