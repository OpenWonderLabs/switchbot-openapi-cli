import { describe, it, expect } from 'vitest';
import { isInQuietHours, isWithin, isWithinTuple } from '../../src/rules/quiet-hours.js';

function at(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

describe('time window helpers', () => {
  it('isWithin handles same-day windows with inclusive start / exclusive end', () => {
    expect(isWithin({ start: '09:00', end: '17:00' }, at('08:59'))).toBe(false);
    expect(isWithin({ start: '09:00', end: '17:00' }, at('09:00'))).toBe(true);
    expect(isWithin({ start: '09:00', end: '17:00' }, at('12:30'))).toBe(true);
    expect(isWithin({ start: '09:00', end: '17:00' }, at('16:59'))).toBe(true);
    expect(isWithin({ start: '09:00', end: '17:00' }, at('17:00'))).toBe(false);
  });

  it('isWithin handles overnight windows (end < start)', () => {
    const w = { start: '22:00', end: '06:00' };
    expect(isWithin(w, at('21:59'))).toBe(false);
    expect(isWithin(w, at('22:00'))).toBe(true);
    expect(isWithin(w, at('23:59'))).toBe(true);
    expect(isWithin(w, at('00:00'))).toBe(true);
    expect(isWithin(w, at('05:59'))).toBe(true);
    expect(isWithin(w, at('06:00'))).toBe(false);
  });

  it('isWithin with equal start/end matches nothing', () => {
    expect(isWithin({ start: '09:00', end: '09:00' }, at('09:00'))).toBe(false);
    expect(isWithin({ start: '09:00', end: '09:00' }, at('12:00'))).toBe(false);
  });

  it('isWithinTuple mirrors isWithin for schema-shape callers', () => {
    expect(isWithinTuple(['09:00', '17:00'], at('12:00'))).toBe(true);
    expect(isWithinTuple(['22:00', '06:00'], at('03:00'))).toBe(true);
  });

  it('rejects malformed HH:MM strings', () => {
    expect(() => isWithin({ start: '25:00', end: '09:00' }, at('12:00'))).toThrow(/Invalid HH:MM/);
    expect(() => isWithin({ start: '09:00', end: '9:60' }, at('12:00'))).toThrow(/Invalid HH:MM/);
  });

  it('isInQuietHours returns false for missing / partial windows', () => {
    expect(isInQuietHours(undefined, at('12:00'))).toBe(false);
    expect(isInQuietHours(null, at('12:00'))).toBe(false);
    expect(isInQuietHours({ start: '22:00' }, at('23:00'))).toBe(false);
    expect(isInQuietHours({ end: '06:00' }, at('05:00'))).toBe(false);
  });

  it('isInQuietHours delegates to isWithin for fully-specified windows', () => {
    expect(isInQuietHours({ start: '22:00', end: '06:00' }, at('23:00'))).toBe(true);
    expect(isInQuietHours({ start: '22:00', end: '06:00' }, at('15:00'))).toBe(false);
  });
});
