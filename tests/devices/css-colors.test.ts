import { describe, it, expect } from 'vitest';
import { CSS_COLORS } from '../../src/devices/css-colors.js';
import { validateParameter } from '../../src/devices/param-validator.js';

describe('CSS_COLORS table', () => {
  it('contains at least 140 entries', () => {
    expect(Object.keys(CSS_COLORS).length).toBeGreaterThanOrEqual(140);
  });

  it('all keys are lowercase', () => {
    for (const key of Object.keys(CSS_COLORS)) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  it('all values are [r,g,b] tuples with 0-255 integers', () => {
    for (const [name, [r, g, b]] of Object.entries(CSS_COLORS)) {
      expect([r, g, b].length, `${name} tuple length`).toBe(3);
      for (const component of [r, g, b]) {
        expect(Number.isInteger(component), `${name} component is integer`).toBe(true);
        expect(component, `${name} component in range`).toBeGreaterThanOrEqual(0);
        expect(component, `${name} component in range`).toBeLessThanOrEqual(255);
      }
    }
  });

  it('spot-checks specific color values', () => {
    expect(CSS_COLORS.coral).toEqual([255, 127, 80]);
    expect(CSS_COLORS.teal).toEqual([0, 128, 128]);
    expect(CSS_COLORS.salmon).toEqual([250, 128, 114]);
    expect(CSS_COLORS.navy).toEqual([0, 0, 128]);
    expect(CSS_COLORS.gold).toEqual([255, 215, 0]);
    expect(CSS_COLORS.tomato).toEqual([255, 99, 71]);
    expect(CSS_COLORS.orchid).toEqual([218, 112, 214]);
    expect(CSS_COLORS.sienna).toEqual([160, 82, 45]);
    expect(CSS_COLORS.aquamarine).toEqual([127, 255, 212]);
    expect(CSS_COLORS.crimson).toEqual([220, 20, 60]);
  });
});

describe('validateParameter — setColor CSS color integration', () => {
  it('resolves coral to 255:127:80', () => {
    const r = validateParameter('Color Bulb', 'setColor', 'coral');
    expect(r.ok).toBe(true);
    expect(r.normalized).toBe('255:127:80');
  });

  it('resolves teal to 0:128:128', () => {
    const r = validateParameter('Color Bulb', 'setColor', 'teal');
    expect(r.ok).toBe(true);
    expect(r.normalized).toBe('0:128:128');
  });

  it('resolves warm (custom) to 255:180:100', () => {
    const r = validateParameter('Color Bulb', 'setColor', 'warm');
    expect(r.ok).toBe(true);
    expect(r.normalized).toBe('255:180:100');
  });

  it('resolves salmon to 250:128:114', () => {
    const r = validateParameter('Color Bulb', 'setColor', 'salmon');
    expect(r.ok).toBe(true);
    expect(r.normalized).toBe('250:128:114');
  });

  it('resolves color names case-insensitively', () => {
    const r = validateParameter('Color Bulb', 'setColor', 'CORAL');
    expect(r.ok).toBe(true);
    expect(r.normalized).toBe('255:127:80');
  });

  it('error message mentions CSS color name', () => {
    const r = validateParameter('Color Bulb', 'setColor', '');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/CSS color name/i);
  });

  it('rejects truly unknown color names', () => {
    const r = validateParameter('Color Bulb', 'setColor', 'mauve');
    expect(r.ok).toBe(false);
  });
});
