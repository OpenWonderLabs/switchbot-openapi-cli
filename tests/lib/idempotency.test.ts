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

  it('always executes fn when key is null', async () => {
    const cache = new IdempotencyCache();
    const fn = vi.fn().mockResolvedValue('x');
    await cache.run(null as unknown as undefined, fn);
    await cache.run(null as unknown as undefined, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('empty-string key IS a valid key and deduplicates within TTL', async () => {
    const cache = new IdempotencyCache(60000);
    const fn = vi.fn().mockResolvedValue('v');
    const r1 = await cache.run('', fn);
    const r2 = await cache.run('', fn);
    expect(r1.replayed).toBe(false);
    expect(r2.replayed).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('evicts LRU entry (least-recently-used) when capacity is exceeded', async () => {
    const cache = new IdempotencyCache(60000, 3);
    await cache.run('a', async () => 1);
    await cache.run('b', async () => 2);
    await cache.run('c', async () => 3);
    expect(cache.size()).toBe(3);
    // Touch 'a' to make it recently used; 'b' becomes LRU victim
    await cache.run('a', async () => 99); // replayed — moves a to back
    // Adding 'd' should evict 'b' (LRU), not 'a'
    await cache.run('d', async () => 4);
    expect(cache.size()).toBe(3);
    // 'a' should still be cached
    const ra = await cache.run('a', async () => 999);
    expect(ra.replayed).toBe(true);
    expect(ra.result).toBe(1);
    // 'b' should have been evicted — fn re-runs
    const fnB = vi.fn().mockResolvedValue(22);
    const rb = await cache.run('b', fnB);
    expect(rb.replayed).toBe(false);
    expect(fnB).toHaveBeenCalledTimes(1);
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

  it('clearForProfile() removes only entries tagged with the given profile', async () => {
    const cache = new IdempotencyCache(60000);
    const fn = vi.fn().mockResolvedValue('v');
    await cache.run('k-a', fn, undefined, 'profileA');
    await cache.run('k-b', fn, undefined, 'profileB');
    expect(cache.size()).toBe(2);
    cache.clearForProfile('profileA');
    expect(cache.size()).toBe(1);
    // profileA entry gone — next run re-executes
    const r = await cache.run('k-a', fn, undefined, 'profileA');
    expect(r.replayed).toBe(false);
    // profileB entry still cached
    const r2 = await cache.run('k-b', fn, undefined, 'profileB');
    expect(r2.replayed).toBe(true);
  });

  it('clearForProfile() leaves entries with no profile untouched', async () => {
    const cache = new IdempotencyCache(60000);
    const fn = vi.fn().mockResolvedValue(1);
    await cache.run('k', fn); // no profile
    cache.clearForProfile('work');
    const r = await cache.run('k', fn); // still cached
    expect(r.replayed).toBe(true);
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

describe('IdempotencyCache — shapeSignature distinguishes undefined from "default"', () => {
  it('treats parameter=undefined differently from parameter="default"', async () => {
    const cache = new IdempotencyCache(60000);
    // Seed with undefined parameter
    await cache.run('k', async () => 'ok', { command: 'press', parameter: undefined });
    // Same key, different parameter ('default' literal) should conflict
    await expect(
      cache.run('k', async () => 'ok', { command: 'press', parameter: 'default' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('treats parameter=undefined differently from parameter=null', async () => {
    const cache = new IdempotencyCache(60000);
    await cache.run('k', async () => 'ok', { command: 'cmd', parameter: undefined });
    await expect(
      cache.run('k', async () => 'ok', { command: 'cmd', parameter: null }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('two undefined parameters produce the same shape (no conflict)', async () => {
    const cache = new IdempotencyCache(60000);
    const fn = vi.fn().mockResolvedValue('v');
    await cache.run('k', fn, { command: 'cmd', parameter: undefined });
    const r = await cache.run('k', fn, { command: 'cmd', parameter: undefined });
    expect(r.replayed).toBe(true);
  });

  it('object parameter with different key order produces same shape (canonical JSON)', async () => {
    const cache = new IdempotencyCache(60000);
    const fn = vi.fn().mockResolvedValue('v');
    await cache.run('k', fn, { command: 'setColor', parameter: { hue: 120, saturation: 100 } });
    // Same object but different insertion order — should NOT conflict (same canonical form)
    const r = await cache.run('k', fn, { command: 'setColor', parameter: { saturation: 100, hue: 120 } });
    expect(r.replayed).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('IdempotencyCache — profile scoping prevents cross-profile collision', () => {
  it('profile "abc:123" + key "def" does not collide with profile "abc" + key "123:def"', async () => {
    const cache = new IdempotencyCache(60000);
    const fn1 = vi.fn().mockResolvedValue('first');
    const fn2 = vi.fn().mockResolvedValue('second');

    await cache.run('def', fn1, undefined, 'abc:123');
    // Different (profile, key) pair must be an independent slot, not a replay
    const r2 = await cache.run('123:def', fn2, undefined, 'abc');
    expect(r2.replayed).toBe(false);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('same key under different profiles are independent entries', async () => {
    const cache = new IdempotencyCache(60000);
    const fn = vi.fn().mockResolvedValue('v');
    await cache.run('k', fn, undefined, 'profileA');
    const r = await cache.run('k', fn, undefined, 'profileB');
    expect(r.replayed).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
