import { describe, it, expect } from 'vitest';
import { ThrottleGate, parseMaxPerMs } from '../../src/rules/throttle.js';

describe('parseMaxPerMs', () => {
  it.each([
    ['10s', 10_000],
    ['5m', 5 * 60_000],
    ['2h', 2 * 3_600_000],
    ['1s', 1_000],
  ])('parses %s → %d ms', (expr, ms) => {
    expect(parseMaxPerMs(expr)).toBe(ms);
  });

  it.each(['10', '10x', '', '0.5m', '1 m'])('rejects invalid expression %s', (expr) => {
    expect(() => parseMaxPerMs(expr)).toThrow(/Invalid throttle.max_per/);
  });
});

describe('ThrottleGate', () => {
  it('always allows when windowMs is null or zero', () => {
    const g = new ThrottleGate();
    expect(g.check('r1', null, Date.now()).allowed).toBe(true);
    expect(g.check('r1', 0, Date.now()).allowed).toBe(true);
  });

  it('allows the first fire and blocks the second inside the window', () => {
    const g = new ThrottleGate();
    const now = 1_700_000_000_000;
    expect(g.check('r1', 10_000, now, 'D1').allowed).toBe(true);
    g.record('r1', now, 'D1');
    const r = g.check('r1', 10_000, now + 5_000, 'D1');
    expect(r.allowed).toBe(false);
    expect(r.nextAllowedAt).toBe(now + 10_000);
    expect(r.lastFiredAt).toBe(now);
  });

  it('reopens the window after enough elapsed time', () => {
    const g = new ThrottleGate();
    const now = 1_700_000_000_000;
    g.record('r1', now, 'D1');
    expect(g.check('r1', 10_000, now + 9_999, 'D1').allowed).toBe(false);
    expect(g.check('r1', 10_000, now + 10_000, 'D1').allowed).toBe(true);
  });

  it('keys fire records by (ruleName, deviceId) so one device does not throttle another', () => {
    const g = new ThrottleGate();
    const now = 1_700_000_000_000;
    g.record('r1', now, 'D1');
    expect(g.check('r1', 60_000, now, 'D1').allowed).toBe(false);
    expect(g.check('r1', 60_000, now, 'D2').allowed).toBe(true);
  });

  it('forget drops all records for a rule (incl. all device keys)', () => {
    const g = new ThrottleGate();
    const now = 1_700_000_000_000;
    g.record('r1', now, 'D1');
    g.record('r1', now, 'D2');
    g.record('r2', now, 'D1');
    expect(g.size()).toBe(3);
    g.forget('r1');
    expect(g.size()).toBe(1);
    expect(g.check('r1', 60_000, now, 'D1').allowed).toBe(true);
  });
});
