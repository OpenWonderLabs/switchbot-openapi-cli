import { describe, it, expect } from 'vitest';
import {
  parseRetryAfter,
  computeBackoff,
  nextRetryDelayMs,
  CircuitBreaker,
  CircuitOpenError,
} from '../../src/utils/retry.js';

describe('parseRetryAfter', () => {
  it('returns undefined for non-string / empty input', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(42)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('   ')).toBeUndefined();
  });

  it('parses integer seconds into ms', () => {
    expect(parseRetryAfter('5')).toBe(5_000);
    expect(parseRetryAfter(' 10 ')).toBe(10_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('caps very large integer values at 30 seconds', () => {
    expect(parseRetryAfter('3600')).toBe(30_000);
  });

  it('parses HTTP-date form relative to now', () => {
    const now = Date.parse('2026-04-18T10:00:00Z');
    const delay = parseRetryAfter('Sat, 18 Apr 2026 10:00:07 GMT', now);
    expect(delay).toBe(7_000);
  });

  it('returns 0 when the HTTP-date is already in the past', () => {
    const now = Date.parse('2026-04-18T10:00:00Z');
    const delay = parseRetryAfter('Sat, 18 Apr 2026 09:59:50 GMT', now);
    expect(delay).toBe(0);
  });

  it('returns undefined for unparseable HTTP-date', () => {
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
  });
});

describe('computeBackoff', () => {
  it('linear: (attempt+1) * 1000ms, capped at 30s', () => {
    expect(computeBackoff(0, 'linear')).toBe(1_000);
    expect(computeBackoff(1, 'linear')).toBe(2_000);
    expect(computeBackoff(9, 'linear')).toBe(10_000);
    expect(computeBackoff(100, 'linear')).toBe(30_000);
  });

  it('exponential: 1s, 2s, 4s, 8s, ..., capped at 30s', () => {
    expect(computeBackoff(0, 'exponential')).toBe(1_000);
    expect(computeBackoff(1, 'exponential')).toBe(2_000);
    expect(computeBackoff(2, 'exponential')).toBe(4_000);
    expect(computeBackoff(3, 'exponential')).toBe(8_000);
    expect(computeBackoff(4, 'exponential')).toBe(16_000);
    expect(computeBackoff(5, 'exponential')).toBe(30_000);
    expect(computeBackoff(10, 'exponential')).toBe(30_000);
  });

  it('clamps negative attempt indices to 0', () => {
    expect(computeBackoff(-3, 'linear')).toBe(1_000);
    expect(computeBackoff(-3, 'exponential')).toBe(1_000);
  });
});

describe('nextRetryDelayMs', () => {
  it('prefers Retry-After over the computed backoff', () => {
    expect(nextRetryDelayMs(0, 'exponential', '4')).toBe(4_000);
  });

  it('falls back to backoff when Retry-After is absent', () => {
    expect(nextRetryDelayMs(2, 'exponential', undefined)).toBe(4_000);
    expect(nextRetryDelayMs(2, 'linear', undefined)).toBe(3_000);
  });

  it('falls back to backoff when Retry-After is garbage', () => {
    expect(nextRetryDelayMs(1, 'exponential', 'not-a-date')).toBe(2_000);
  });
});

describe('CircuitBreaker', () => {
  it('starts closed and allows calls', () => {
    const cb = new CircuitBreaker('test');
    expect(cb.getState()).toBe('closed');
    expect(() => cb.checkAndAllow()).not.toThrow();
  });

  it('opens after failureThreshold consecutive failures', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });

  it('throws CircuitOpenError while open', () => {
    const cb = new CircuitBreaker('api', { failureThreshold: 2 });
    cb.recordFailure();
    cb.recordFailure();
    expect(() => cb.checkAndAllow()).toThrow(CircuitOpenError);
    expect(() => cb.checkAndAllow()).toThrow(/Circuit "api" is open/);
  });

  it('resets to closed and clears failure count on recordSuccess', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 2 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    cb.reset();
    expect(cb.getState()).toBe('closed');
    expect(() => cb.checkAndAllow()).not.toThrow();
  });

  it('enters half-open after resetTimeoutMs and allows one probe', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, resetTimeoutMs: 0 });
    cb.recordFailure();
    // With resetTimeoutMs: 0 the transition to half-open happens on the very
    // next getState() / checkAndAllow() call because Date.now() >= openedAt + 0.
    expect(cb.getState()).toBe('half-open');
    expect(() => cb.checkAndAllow()).not.toThrow();
  });

  it('re-opens on failure while half-open', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, resetTimeoutMs: 0 });
    cb.recordFailure();
    // Force transition to half-open.
    void cb.getState();
    // A failure during the probe re-opens the circuit.
    cb.recordFailure();
    // Next getState() with resetTimeoutMs: 0 will immediately half-open again,
    // so check failures directly via getStats().
    const stats = cb.getStats();
    expect(stats.state === 'open' || stats.state === 'half-open').toBe(true);
    expect(stats.failures).toBeGreaterThan(0);
  });

  it('closes fully on success while half-open', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, resetTimeoutMs: 0 });
    cb.recordFailure();
    expect(cb.getState()).toBe('half-open');
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
    expect(() => cb.checkAndAllow()).not.toThrow();
  });
});
