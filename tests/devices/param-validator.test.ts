import { describe, it, expect } from 'vitest';
import {
  buildAcSetAll,
  buildCurtainSetPosition,
  buildBlindTiltSetPosition,
  buildRelaySetMode,
  validateParameter,
} from '../../src/devices/param-validator.js';

describe('buildAcSetAll (semantic-flag → wire)', () => {
  it('maps mode + fan + on/off to CSV', () => {
    expect(
      buildAcSetAll({ temp: '26', mode: 'cool', fan: 'low', power: 'on' })
    ).toBe('26,2,2,on');
    expect(
      buildAcSetAll({ temp: '22', mode: 'heat', fan: 'auto', power: 'on' })
    ).toBe('22,5,1,on');
  });

  it('rejects out-of-range temperature', () => {
    expect(() => buildAcSetAll({ temp: '99', mode: 'cool', fan: 'low', power: 'on' })).toThrow(/16 and 30/);
    expect(() => buildAcSetAll({ temp: '10', mode: 'cool', fan: 'low', power: 'on' })).toThrow(/16 and 30/);
  });

  it('rejects unknown mode / fan / power', () => {
    expect(() => buildAcSetAll({ temp: '22', mode: 'turbo', fan: 'low', power: 'on' })).toThrow(/auto, cool, dry, fan, heat/);
    expect(() => buildAcSetAll({ temp: '22', mode: 'cool', fan: 'breeze', power: 'on' })).toThrow(/auto, low, mid, high/);
    expect(() => buildAcSetAll({ temp: '22', mode: 'cool', fan: 'low', power: 'yes' })).toThrow(/"on" or "off"/);
  });

  it('rejects missing flags', () => {
    expect(() => buildAcSetAll({ mode: 'cool', fan: 'low', power: 'on' })).toThrow(/--temp/);
    expect(() => buildAcSetAll({ temp: '22', fan: 'low', power: 'on' })).toThrow(/--mode/);
  });
});

describe('buildCurtainSetPosition', () => {
  it('defaults mode to ff', () => {
    expect(buildCurtainSetPosition({ position: '30' })).toBe('0,ff,30');
  });

  it('maps silent/performance/default modes', () => {
    expect(buildCurtainSetPosition({ position: '50', mode: 'silent' })).toBe('0,1,50');
    expect(buildCurtainSetPosition({ position: '50', mode: 'performance' })).toBe('0,0,50');
    expect(buildCurtainSetPosition({ position: '50', mode: 'default' })).toBe('0,ff,50');
  });

  it('rejects out-of-range position and bad mode', () => {
    expect(() => buildCurtainSetPosition({ position: '101' })).toThrow(/0 and 100/);
    expect(() => buildCurtainSetPosition({ position: '50', mode: 'turbo' })).toThrow(/default, performance, silent/);
  });
});

describe('buildBlindTiltSetPosition', () => {
  it('combines direction + angle', () => {
    expect(buildBlindTiltSetPosition({ direction: 'up', angle: '50' })).toBe('up;50');
    expect(buildBlindTiltSetPosition({ direction: 'down', angle: '0' })).toBe('down;0');
  });

  it('rejects invalid direction and angle', () => {
    expect(() => buildBlindTiltSetPosition({ direction: 'left', angle: '50' })).toThrow(/"up" or "down"/);
    expect(() => buildBlindTiltSetPosition({ direction: 'up', angle: '150' })).toThrow(/0 and 100/);
  });
});

describe('buildRelaySetMode', () => {
  it('combines channel + mode', () => {
    expect(buildRelaySetMode({ channel: '1', mode: 'edge' })).toBe('1;1');
    expect(buildRelaySetMode({ channel: '2', mode: 'momentary' })).toBe('2;3');
  });

  it('rejects invalid channel and mode', () => {
    expect(() => buildRelaySetMode({ channel: '3', mode: 'edge' })).toThrow(/1 or 2/);
    expect(() => buildRelaySetMode({ channel: '1', mode: 'pulse' })).toThrow(/toggle, edge, detached, momentary/);
  });
});

describe('validateParameter (raw wire-format validator)', () => {
  // ---- AC setAll ----
  it('accepts valid AC setAll CSV', () => {
    const r = validateParameter('Air Conditioner', 'setAll', '26,2,2,on');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('26,2,2,on');
  });

  it('rejects empty / default / undefined AC setAll parameter', () => {
    for (const raw of [undefined, '', 'default']) {
      const r = validateParameter('Air Conditioner', 'setAll', raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/requires a parameter/);
    }
  });

  it('rejects JSON-shaped AC setAll parameter', () => {
    const r = validateParameter('Air Conditioner', 'setAll', '{"temp":30}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/CSV string/);
  });

  it('rejects wrong field count', () => {
    const r = validateParameter('Air Conditioner', 'setAll', '30');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/4 comma-separated/);
  });

  it('rejects non-integer / out-of-range temp', () => {
    const r1 = validateParameter('Air Conditioner', 'setAll', 'on,2,2,30');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toMatch(/temp.*16-30/i);

    const r2 = validateParameter('Air Conditioner', 'setAll', '99,2,2,on');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/temp.*16-30/i);
  });

  it('rejects out-of-range mode and fan', () => {
    const bad = validateParameter('Air Conditioner', 'setAll', '26,9,2,on');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/mode/);
  });

  it('rejects bad power field', () => {
    const r = validateParameter('Air Conditioner', 'setAll', '26,2,2,yes');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/power.*on.*off/i);
  });

  // ---- Curtain setPosition ----
  it('accepts Curtain setPosition single-value form', () => {
    const r = validateParameter('Curtain', 'setPosition', '50');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('50');
  });

  it('accepts Curtain setPosition tuple form', () => {
    const r = validateParameter('Curtain 3', 'setPosition', '0,ff,80');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('0,ff,80');
  });

  it('rejects Curtain setPosition out-of-range', () => {
    const r = validateParameter('Curtain', 'setPosition', '150');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/0-100/);
  });

  it('rejects Curtain setPosition bad mode flag', () => {
    const r = validateParameter('Curtain', 'setPosition', '0,bogus,50');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ff.*0.*1/);
  });

  // ---- Blind Tilt setPosition ----
  it('accepts Blind Tilt setPosition', () => {
    const r = validateParameter('Blind Tilt', 'setPosition', 'up;50');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('up;50');
  });

  it('rejects Blind Tilt setPosition bad direction', () => {
    const r = validateParameter('Blind Tilt', 'setPosition', 'left;50');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/up.*down/);
  });

  // ---- Relay Switch setMode ----
  it('accepts Relay Switch setMode', () => {
    const r = validateParameter('Relay Switch 2PM', 'setMode', '1;1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('1;1');
  });

  it('rejects Relay Switch setMode bad channel', () => {
    const r = validateParameter('Relay Switch 2PM', 'setMode', '3;1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/1 or 2/);
  });

  // ---- Passthrough ----
  it('passes through unknown (type, command) combos', () => {
    const r = validateParameter('Smart Lock', 'setColor', '255:0:0');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBeUndefined();
  });

  it('passes through when deviceType is undefined', () => {
    const r = validateParameter(undefined, 'setAll', 'anything');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBeUndefined();
  });

  it('passes through unknown commands on known device types', () => {
    const r = validateParameter('Air Conditioner', 'customButton', 'xyz');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBeUndefined();
  });
});

describe('validateParameter — setBrightness (2.6.0, B-1)', () => {
  it('accepts integer 1-100 on Color Bulb', () => {
    const r = validateParameter('Color Bulb', 'setBrightness', '50');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('50');
  });

  it('accepts boundary values 1 and 100', () => {
    expect(validateParameter('Color Bulb', 'setBrightness', '1').ok).toBe(true);
    expect(validateParameter('Color Bulb', 'setBrightness', '100').ok).toBe(true);
  });

  it('rejects 0, 101, negative, and floats', () => {
    expect(validateParameter('Color Bulb', 'setBrightness', '0').ok).toBe(false);
    expect(validateParameter('Color Bulb', 'setBrightness', '101').ok).toBe(false);
    expect(validateParameter('Color Bulb', 'setBrightness', '-1').ok).toBe(false);
    expect(validateParameter('Color Bulb', 'setBrightness', '50.5').ok).toBe(false);
  });

  it('rejects non-numeric strings', () => {
    expect(validateParameter('Color Bulb', 'setBrightness', 'half').ok).toBe(false);
    expect(validateParameter('Color Bulb', 'setBrightness', '').ok).toBe(false);
  });

  it('passes through on device types that do not expose brightness', () => {
    const r = validateParameter('Bot', 'setBrightness', '999');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBeUndefined();
  });
});

describe('validateParameter — setColor (2.6.0, B-1 + B-12)', () => {
  it('accepts R:G:B form and passes through unchanged', () => {
    const r = validateParameter('Color Bulb', 'setColor', '255:128:0');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('255:128:0');
  });

  it('accepts R,G,B and normalizes to R:G:B', () => {
    const r = validateParameter('Color Bulb', 'setColor', '0,255,0');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('0:255:0');
  });

  it('accepts #RRGGBB and normalizes to decimal R:G:B', () => {
    const r = validateParameter('Color Bulb', 'setColor', '#FF0000');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('255:0:0');
  });

  it('accepts short #RGB hex', () => {
    const r = validateParameter('Color Bulb', 'setColor', '#F00');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('255:0:0');
  });

  it('accepts named colors', () => {
    const red = validateParameter('Color Bulb', 'setColor', 'red');
    expect(red.ok).toBe(true);
    if (red.ok) expect(red.normalized).toBe('255:0:0');
    const blue = validateParameter('Color Bulb', 'setColor', 'BLUE');
    expect(blue.ok).toBe(true);
    if (blue.ok) expect(blue.normalized).toBe('0:0:255');
  });

  it('rejects out-of-range components', () => {
    expect(validateParameter('Color Bulb', 'setColor', '999:0:0').ok).toBe(false);
    expect(validateParameter('Color Bulb', 'setColor', '-1:0:0').ok).toBe(false);
  });

  it('rejects wrong number of components', () => {
    expect(validateParameter('Color Bulb', 'setColor', '255:0').ok).toBe(false);
    expect(validateParameter('Color Bulb', 'setColor', '255:0:0:0').ok).toBe(false);
  });

  it('rejects unknown named color / garbage', () => {
    expect(validateParameter('Color Bulb', 'setColor', 'mauve').ok).toBe(false);
    expect(validateParameter('Color Bulb', 'setColor', '#GGGGGG').ok).toBe(false);
  });
});
