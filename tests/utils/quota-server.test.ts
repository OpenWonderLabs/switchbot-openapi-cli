import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearServerQuota,
  getServerQuota,
  recordServerQuota,
  todayUsage,
} from '../../src/utils/quota.js';

describe('server-quota observations', () => {
  beforeEach(() => {
    clearServerQuota();
  });

  it('is null before any observation', () => {
    expect(getServerQuota()).toBeNull();
    expect(todayUsage().server).toBeUndefined();
  });

  it('records a ratelimit-remaining observation and includes it in todayUsage', () => {
    recordServerQuota(8432, new Date('2026-04-19T10:00:00Z'));
    const obs = getServerQuota();
    expect(obs).not.toBeNull();
    expect(obs!.remaining).toBe(8432);
    expect(obs!.observedAt).toBe('2026-04-19T10:00:00.000Z');
    expect(todayUsage().server).toEqual({
      remaining: 8432,
      observedAt: '2026-04-19T10:00:00.000Z',
    });
  });

  it('overwrites with the latest observation', () => {
    recordServerQuota(9000, new Date('2026-04-19T09:00:00Z'));
    recordServerQuota(8500, new Date('2026-04-19T10:00:00Z'));
    expect(getServerQuota()!.remaining).toBe(8500);
  });

  it('floors non-integer values and rejects negatives/non-finite', () => {
    recordServerQuota(42.7);
    expect(getServerQuota()!.remaining).toBe(42);
    recordServerQuota(-1);
    expect(getServerQuota()!.remaining).toBe(42); // unchanged
    recordServerQuota(Number.NaN);
    expect(getServerQuota()!.remaining).toBe(42); // unchanged
  });

  it('clearServerQuota resets the observation', () => {
    recordServerQuota(10);
    clearServerQuota();
    expect(getServerQuota()).toBeNull();
  });
});
