import { describe, it, expect } from 'vitest';
import {
  buildAcSetAll,
  buildCurtainSetPosition,
  buildBlindTiltSetPosition,
  buildBrightnessSet,
  buildRelaySetMode,
  parseParameterForWire,
  validateParameter,
} from '../../src/devices/param-validator.js';

describe('parseParameterForWire', () => {
  it('keeps scalar numeric parameters as strings', () => {
    expect(parseParameterForWire('50')).toBe('50');
    expect(parseParameterForWire('true')).toBe('true');
  });

  it('parses JSON object parameters and preserves numeric fields', () => {
    expect(parseParameterForWire('{"mode":7,"targetHumidify":50}')).toEqual({
      mode: 7,
      targetHumidify: 50,
    });
  });
});

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

  it('rejects odd angles (must be multiple of 2)', () => {
    expect(() => buildBlindTiltSetPosition({ direction: 'up', angle: '51' })).toThrow(/multiple of 2/);
    expect(() => buildBlindTiltSetPosition({ direction: 'down', angle: '1' })).toThrow(/multiple of 2/);
    expect(buildBlindTiltSetPosition({ direction: 'up', angle: '50' })).toBe('up;50');
    expect(buildBlindTiltSetPosition({ direction: 'down', angle: '0' })).toBe('down;0');
  });
});

describe('buildBrightnessSet', () => {
  it('returns brightness string for default 1-100 range', () => {
    expect(buildBrightnessSet({ brightness: '50' })).toBe('50');
    expect(buildBrightnessSet({ brightness: '1' })).toBe('1');
    expect(buildBrightnessSet({ brightness: '100' })).toBe('100');
  });

  it('rejects 0 for devices without 0-100 range', () => {
    expect(() => buildBrightnessSet({ brightness: '0' })).toThrow(/between 1 and 100/);
    expect(() => buildBrightnessSet({ brightness: '0' }, 'Color Bulb')).toThrow(/between 1 and 100/);
  });

  it('allows 0 for 0-100 devices (Floor Lamp, Strip Light 3, RGBICWW)', () => {
    expect(buildBrightnessSet({ brightness: '0' }, 'Floor Lamp')).toBe('0');
    expect(buildBrightnessSet({ brightness: '0' }, 'Strip Light 3')).toBe('0');
    expect(buildBrightnessSet({ brightness: '0' }, 'RGBICWW Strip Light')).toBe('0');
    expect(buildBrightnessSet({ brightness: '0' }, 'Candle Warmer Lamp')).toBe('0');
  });

  it('rejects values outside range', () => {
    expect(() => buildBrightnessSet({ brightness: '101' })).toThrow(/between 1 and 100/);
    expect(() => buildBrightnessSet({ brightness: '-1' }, 'Floor Lamp')).toThrow(/between 0 and 100/);
  });

  it('throws when --brightness is missing', () => {
    expect(() => buildBrightnessSet({})).toThrow(/--brightness is required/);
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

describe('validateParameter — Relay Switch 2PM channel (turnOn/turnOff/toggle)', () => {
  it('accepts "1" and "2" for turnOn/turnOff/toggle', () => {
    for (const cmd of ['turnOn', 'turnOff', 'toggle']) {
      const r1 = validateParameter('Relay Switch 2PM', cmd, '1');
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.normalized).toBe('1');
      const r2 = validateParameter('Relay Switch 2PM', cmd, '2');
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.normalized).toBe('2');
    }
  });

  it('rejects missing / empty / default parameter', () => {
    for (const raw of [undefined, '', 'default']) {
      const r = validateParameter('Relay Switch 2PM', 'turnOff', raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/channel/);
    }
  });

  it('rejects invalid channel values', () => {
    for (const raw of ['0', '3', 'abc', '1;2']) {
      const r = validateParameter('Relay Switch 2PM', 'turnOn', raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/"1" or "2"/);
    }
  });

  it('auto-coerces quoted input (e.g. \'"1"\') to string channel', () => {
    const r = validateParameter('Relay Switch 2PM', 'turnOff', '"1"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('1');
    const r2 = validateParameter('Relay Switch 2PM', 'turnOn', '"2"');
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.normalized).toBe('2');
  });

  it('does not trigger for Relay Switch 1 (no channel needed)', () => {
    const r = validateParameter('Relay Switch 1', 'turnOn', undefined);
    expect(r.ok).toBe(true);
  });

  it('normalizes to the scalar string channel used on the wire', () => {
    const r = validateParameter('Relay Switch 2PM', 'turnOff', '1');
    expect(r.ok).toBe(true);
    if (r.ok && r.normalized) {
      expect(r.normalized).toBe('1');
    }
  });
});

describe('validateParameter — Relay Switch 1/1PM setMode', () => {
  it('accepts a single mode value 0-3', () => {
    const r = validateParameter('Relay Switch 1', 'setMode', '3');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('3');
  });

  it('rejects Relay Switch 2PM channel-mode tuple for Relay Switch 1', () => {
    const r = validateParameter('Relay Switch 1PM', 'setMode', '1;0');
    expect(r.ok).toBe(false);
  });
});

describe('validateParameter — Relay Switch 2PM setPosition', () => {
  it('accepts 0-100', () => {
    expect(validateParameter('Relay Switch 2PM', 'setPosition', '0').ok).toBe(true);
    expect(validateParameter('Relay Switch 2PM', 'setPosition', '50').ok).toBe(true);
    expect(validateParameter('Relay Switch 2PM', 'setPosition', '100').ok).toBe(true);
  });

  it('rejects out-of-range', () => {
    expect(validateParameter('Relay Switch 2PM', 'setPosition', '101').ok).toBe(false);
    expect(validateParameter('Relay Switch 2PM', 'setPosition', '-1').ok).toBe(false);
  });

  it('rejects non-numeric', () => {
    expect(validateParameter('Relay Switch 2PM', 'setPosition', 'half').ok).toBe(false);
  });
});

describe('validateParameter — Humidifier setMode', () => {
  it('accepts "auto"', () => {
    const r = validateParameter('Humidifier', 'setMode', 'auto');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('auto');
  });

  it('accepts preset values 101, 102, 103', () => {
    for (const v of ['101', '102', '103']) {
      expect(validateParameter('Humidifier', 'setMode', v).ok).toBe(true);
    }
  });

  it('accepts humidity percentage 0-100', () => {
    expect(validateParameter('Humidifier', 'setMode', '0').ok).toBe(true);
    expect(validateParameter('Humidifier', 'setMode', '50').ok).toBe(true);
    expect(validateParameter('Humidifier', 'setMode', '100').ok).toBe(true);
  });

  it('rejects invalid values', () => {
    expect(validateParameter('Humidifier', 'setMode', '104').ok).toBe(false);
    expect(validateParameter('Humidifier', 'setMode', 'turbo').ok).toBe(false);
    expect(validateParameter('Humidifier', 'setMode', '').ok).toBe(false);
  });
});

describe('validateParameter — Humidifier2 setMode', () => {
  it('accepts valid JSON', () => {
    const r = validateParameter('Humidifier2', 'setMode', '{"mode":7,"targetHumidify":50}');
    expect(r.ok).toBe(true);
  });

  it('normalizes numeric string fields to JSON numbers', () => {
    const r = validateParameter('Humidifier2', 'setMode', '{"mode":"7","targetHumidify":"50"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.normalized!)).toEqual({ mode: 7, targetHumidify: 50 });
  });

  it('rejects non-JSON', () => {
    const r = validateParameter('Humidifier2', 'setMode', 'auto');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/);
  });

  it('rejects out-of-range mode', () => {
    expect(validateParameter('Humidifier2', 'setMode', '{"mode":9,"targetHumidify":50}').ok).toBe(false);
    expect(validateParameter('Humidifier2', 'setMode', '{"mode":0,"targetHumidify":50}').ok).toBe(false);
  });

  it('rejects out-of-range targetHumidify', () => {
    expect(validateParameter('Humidifier2', 'setMode', '{"mode":1,"targetHumidify":101}').ok).toBe(false);
  });

  it('rejects non-numeric field types (boolean, array, object)', () => {
    expect(validateParameter('Humidifier2', 'setMode', '{"mode":true,"targetHumidify":50}').ok).toBe(false);
    expect(validateParameter('Humidifier2', 'setMode', '{"mode":1,"targetHumidify":false}').ok).toBe(false);
    expect(validateParameter('Humidifier2', 'setMode', '{"mode":[7],"targetHumidify":50}').ok).toBe(false);
    expect(validateParameter('Humidifier2', 'setMode', '{"mode":1,"targetHumidify":null}').ok).toBe(false);
  });
});

describe('validateParameter — Humidifier2 setChildLock', () => {
  it('accepts "true" and "false"', () => {
    expect(validateParameter('Humidifier2', 'setChildLock', 'true').ok).toBe(true);
    expect(validateParameter('Humidifier2', 'setChildLock', 'false').ok).toBe(true);
  });

  it('rejects invalid values', () => {
    expect(validateParameter('Humidifier2', 'setChildLock', '1').ok).toBe(false);
    expect(validateParameter('Humidifier2', 'setChildLock', 'yes').ok).toBe(false);
  });
});

describe('validateParameter — Air Purifier VOC setMode', () => {
  it('accepts valid JSON', () => {
    expect(validateParameter('Air Purifier VOC', 'setMode', '{"mode":2}').ok).toBe(true);
    expect(validateParameter('Air Purifier VOC', 'setMode', '{"mode":1,"fanGear":2}').ok).toBe(true);
  });

  it('rejects out-of-range mode', () => {
    expect(validateParameter('Air Purifier VOC', 'setMode', '{"mode":5}').ok).toBe(false);
  });

  it('rejects out-of-range fanGear', () => {
    expect(validateParameter('Air Purifier VOC', 'setMode', '{"mode":1,"fanGear":4}').ok).toBe(false);
  });

  it('rejects non-JSON', () => {
    expect(validateParameter('Air Purifier VOC', 'setMode', 'auto').ok).toBe(false);
  });

  it('rejects fanGear unless mode is 1', () => {
    const r = validateParameter('Air Purifier VOC', 'setMode', '{"mode":2,"fanGear":3}');
    expect(r.ok).toBe(false);
  });
});

describe('validateParameter — Air Purifier VOC setChildLock', () => {
  it('accepts "0" and "1"', () => {
    expect(validateParameter('Air Purifier VOC', 'setChildLock', '0').ok).toBe(true);
    expect(validateParameter('Air Purifier VOC', 'setChildLock', '1').ok).toBe(true);
  });

  it('rejects invalid', () => {
    expect(validateParameter('Air Purifier VOC', 'setChildLock', '2').ok).toBe(false);
    expect(validateParameter('Air Purifier VOC', 'setChildLock', 'on').ok).toBe(false);
  });
});

describe('validateParameter — Robot Vacuum S1 PowLevel', () => {
  it('accepts 0-3', () => {
    for (const v of ['0', '1', '2', '3']) {
      expect(validateParameter('Robot Vacuum Cleaner S1', 'PowLevel', v).ok).toBe(true);
    }
  });

  it('rejects out-of-range', () => {
    expect(validateParameter('Robot Vacuum Cleaner S1', 'PowLevel', '4').ok).toBe(false);
    expect(validateParameter('Robot Vacuum Cleaner S1', 'PowLevel', '-1').ok).toBe(false);
  });
});

describe('validateParameter — Vacuum startClean', () => {
  it('accepts valid S10 startClean', () => {
    const r = validateParameter('Floor Cleaning Robot S10', 'startClean', '{"action":"sweep","param":{"fanLevel":2,"times":1}}');
    expect(r.ok).toBe(true);
  });

  it('accepts valid K10+ startClean', () => {
    const r = validateParameter('K10+ Pro Combo', 'startClean', '{"action":"mop","param":{"fanLevel":1,"times":1}}');
    expect(r.ok).toBe(true);
  });

  it('rejects invalid action for S10', () => {
    const r = validateParameter('Floor Cleaning Robot S10', 'startClean', '{"action":"mop","param":{"fanLevel":1,"times":1}}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sweep, sweep_mop/);
  });

  it('rejects invalid action for K10+', () => {
    const r = validateParameter('K10+ Pro Combo', 'startClean', '{"action":"sweep_mop","param":{"fanLevel":1,"times":1}}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sweep, mop/);
  });

  it('rejects non-JSON', () => {
    expect(validateParameter('Floor Cleaning Robot S10', 'startClean', 'start').ok).toBe(false);
  });

  it('rejects out-of-range fanLevel', () => {
    const r = validateParameter('Floor Cleaning Robot S10', 'startClean', '{"action":"sweep","param":{"fanLevel":5,"times":1}}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/fanLevel.*1-4/);
  });
});

describe('validateParameter — Vacuum setVolume', () => {
  it('accepts 0-100', () => {
    expect(validateParameter('Floor Cleaning Robot S10', 'setVolume', '50').ok).toBe(true);
    expect(validateParameter('K10+ Pro Combo', 'setVolume', '0').ok).toBe(true);
  });

  it('rejects out-of-range', () => {
    expect(validateParameter('Floor Cleaning Robot S10', 'setVolume', '101').ok).toBe(false);
  });
});

describe('validateParameter — S10 selfClean', () => {
  it('accepts 1, 2, 3', () => {
    for (const v of ['1', '2', '3']) {
      expect(validateParameter('Floor Cleaning Robot S10', 'selfClean', v).ok).toBe(true);
    }
  });

  it('rejects invalid values', () => {
    expect(validateParameter('Floor Cleaning Robot S10', 'selfClean', '0').ok).toBe(false);
    expect(validateParameter('Floor Cleaning Robot S10', 'selfClean', '4').ok).toBe(false);
    expect(validateParameter('Floor Cleaning Robot S10', 'selfClean', 'wash').ok).toBe(false);
  });
});

describe('validateParameter — Vacuum changeParam', () => {
  it('accepts valid JSON', () => {
    expect(validateParameter('Floor Cleaning Robot S10', 'changeParam', '{"fanLevel":3,"waterLevel":1,"times":1}').ok).toBe(true);
  });

  it('rejects out-of-range fanLevel', () => {
    expect(validateParameter('K10+ Pro Combo', 'changeParam', '{"fanLevel":5}').ok).toBe(false);
  });

  it('rejects out-of-range waterLevel', () => {
    expect(validateParameter('Floor Cleaning Robot S10', 'changeParam', '{"waterLevel":3}').ok).toBe(false);
  });

  it('rejects waterLevel for all combo vacuum aliases', () => {
    expect(validateParameter('K10+ Pro Combo', 'changeParam', '{"waterLevel":1}').ok).toBe(false);
    expect(validateParameter('Robot Vacuum Cleaner K10+ Pro Combo', 'changeParam', '{"waterLevel":1}').ok).toBe(false);
    expect(validateParameter('K20+ Pro', 'changeParam', '{"waterLevel":1}').ok).toBe(false);
    expect(validateParameter('K11+', 'changeParam', '{"waterLevel":1}').ok).toBe(false);
    expect(validateParameter('Robot Vacuum Cleaner K11+', 'changeParam', '{"waterLevel":1}').ok).toBe(false);
  });

  it('rejects non-numeric field types (boolean, array)', () => {
    expect(validateParameter('Floor Cleaning Robot S10', 'changeParam', '{"fanLevel":true}').ok).toBe(false);
    expect(validateParameter('Floor Cleaning Robot S10', 'changeParam', '{"waterLevel":[1]}').ok).toBe(false);
    expect(validateParameter('Floor Cleaning Robot S10', 'changeParam', '{"times":false}').ok).toBe(false);
  });

  it('rejects non-JSON', () => {
    expect(validateParameter('Floor Cleaning Robot S10', 'changeParam', 'fast').ok).toBe(false);
  });
});

describe('validateParameter — Battery Circulator Fan', () => {
  it('validates setNightLightMode', () => {
    expect(validateParameter('Battery Circulator Fan', 'setNightLightMode', 'off').ok).toBe(true);
    expect(validateParameter('Battery Circulator Fan', 'setNightLightMode', '1').ok).toBe(true);
    expect(validateParameter('Battery Circulator Fan', 'setNightLightMode', '2').ok).toBe(true);
    expect(validateParameter('Battery Circulator Fan', 'setNightLightMode', '3').ok).toBe(false);
  });

  it('validates setWindMode', () => {
    for (const v of ['direct', 'natural', 'sleep', 'baby']) {
      expect(validateParameter('Battery Circulator Fan', 'setWindMode', v).ok).toBe(true);
    }
    expect(validateParameter('Battery Circulator Fan', 'setWindMode', 'turbo').ok).toBe(false);
  });

  it('validates setWindSpeed 1-100', () => {
    expect(validateParameter('Battery Circulator Fan', 'setWindSpeed', '1').ok).toBe(true);
    expect(validateParameter('Battery Circulator Fan', 'setWindSpeed', '100').ok).toBe(true);
    expect(validateParameter('Battery Circulator Fan', 'setWindSpeed', '0').ok).toBe(false);
    expect(validateParameter('Battery Circulator Fan', 'setWindSpeed', '101').ok).toBe(false);
  });

  it('validates closeDelay 1-36000 for fan aliases', () => {
    expect(validateParameter('Circulator Fan', 'closeDelay', '1').ok).toBe(true);
    expect(validateParameter('Standing Circulator Fan', 'closeDelay', '36000').ok).toBe(true);
    expect(validateParameter('Battery Circulator Fan', 'closeDelay', '0').ok).toBe(false);
  });
});

describe('validateParameter — documented lighting ranges', () => {
  it('allows 0 brightness for 0-100 lighting devices', () => {
    expect(validateParameter('Floor Lamp', 'setBrightness', '0').ok).toBe(true);
    expect(validateParameter('RGBICWW Strip Light', 'setBrightness', '0').ok).toBe(true);
    expect(validateParameter('Candle Warmer Lamp', 'setBrightness', '0').ok).toBe(true);
  });

  it('keeps Color Bulb brightness at 1-100', () => {
    expect(validateParameter('Color Bulb', 'setBrightness', '0').ok).toBe(false);
  });
});

describe('validateParameter — Blind Tilt setPosition', () => {
  it('rejects odd angle values because the API requires multiples of 2', () => {
    const r = validateParameter('Blind Tilt', 'setPosition', 'up;51');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/multiple of 2/);
  });
});

describe('validateParameter — Smart Radiator Thermostat', () => {
  it('validates setMode 0-5', () => {
    for (const v of ['0', '1', '2', '3', '4', '5']) {
      expect(validateParameter('Smart Radiator Thermostat', 'setMode', v).ok).toBe(true);
    }
    expect(validateParameter('Smart Radiator Thermostat', 'setMode', '6').ok).toBe(false);
  });

  it('validates setManualModeTemperature 4-35', () => {
    expect(validateParameter('Smart Radiator Thermostat', 'setManualModeTemperature', '4').ok).toBe(true);
    expect(validateParameter('Smart Radiator Thermostat', 'setManualModeTemperature', '5').ok).toBe(true);
    expect(validateParameter('Smart Radiator Thermostat', 'setManualModeTemperature', '22').ok).toBe(true);
    expect(validateParameter('Smart Radiator Thermostat', 'setManualModeTemperature', '30').ok).toBe(true);
    expect(validateParameter('Smart Radiator Thermostat', 'setManualModeTemperature', '35').ok).toBe(true);
    expect(validateParameter('Smart Radiator Thermostat', 'setManualModeTemperature', '3').ok).toBe(false);
    expect(validateParameter('Smart Radiator Thermostat', 'setManualModeTemperature', '36').ok).toBe(false);
  });
});

describe('validateParameter — Keypad', () => {
  it('validates createKey', () => {
    const valid = '{"name":"test","type":"permanent","password":"123456"}';
    expect(validateParameter('Keypad', 'createKey', valid).ok).toBe(true);
  });

  it('rejects createKey with missing fields', () => {
    expect(validateParameter('Keypad', 'createKey', '{"name":"test"}').ok).toBe(false);
    expect(validateParameter('Keypad', 'createKey', '{"name":"test","type":"bad","password":"123456"}').ok).toBe(false);
  });

  it('rejects createKey with invalid password length', () => {
    expect(validateParameter('Keypad', 'createKey', '{"name":"test","type":"permanent","password":"123"}').ok).toBe(false);
  });

  it('validates deleteKey', () => {
    expect(validateParameter('Keypad', 'deleteKey', '{"id":12345}').ok).toBe(true);
    expect(validateParameter('Keypad', 'deleteKey', '{"id":"abc123"}').ok).toBe(true);
  });

  it('rejects deleteKey without id', () => {
    expect(validateParameter('Keypad', 'deleteKey', '{}').ok).toBe(false);
  });
});

describe('validateParameter — TV SetChannel', () => {
  it('accepts 1-999', () => {
    expect(validateParameter('TV', 'SetChannel', '1').ok).toBe(true);
    expect(validateParameter('TV', 'SetChannel', '999').ok).toBe(true);
  });

  it('rejects out-of-range', () => {
    expect(validateParameter('TV', 'SetChannel', '0').ok).toBe(false);
    expect(validateParameter('TV', 'SetChannel', '1000').ok).toBe(false);
  });

  it('auto-coerces quoted numeric input', () => {
    const r = validateParameter('TV', 'SetChannel', '"15"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('15');
  });
});

describe('validateParameter — auto-coercion of quoted numeric input', () => {
  it('Relay Switch 2PM channel: "1" (quoted) → string "1" in body', () => {
    const r = validateParameter('Relay Switch 2PM', 'turnOff', '"1"');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized).toBe('1');
    }
  });

  it('setVolume: "50" (quoted) → accepted', () => {
    const r = validateParameter('Floor Cleaning Robot S10', 'setVolume', '"50"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('50');
  });

  it('setWindSpeed: "75" (quoted) → accepted', () => {
    const r = validateParameter('Battery Circulator Fan', 'setWindSpeed', '"75"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('75');
  });

  it('setWindMode: "natural" (quoted) → accepted', () => {
    const r = validateParameter('Battery Circulator Fan', 'setWindMode', '"natural"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('natural');
  });

  it('Humidifier setMode: "auto" (quoted) → accepted', () => {
    const r = validateParameter('Humidifier', 'setMode', '"auto"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('auto');
  });

  it('selfClean: "2" (quoted) → accepted', () => {
    const r = validateParameter('Floor Cleaning Robot S10', 'selfClean', '"2"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('2');
  });

  it('setBrightness: "50" (quoted) → accepted', () => {
    const r = validateParameter('Color Bulb', 'setBrightness', '"50"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('50');
  });

  it('setColorTemperature: "4000" (quoted) → accepted', () => {
    const r = validateParameter('Color Bulb', 'setColorTemperature', '"4000"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('4000');
  });

  it('setColor: "255:0:0" (quoted) → accepted', () => {
    const r = validateParameter('Color Bulb', 'setColor', '"255:0:0"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('255:0:0');
  });

  it('Curtain setPosition: "50" (quoted) → accepted', () => {
    const r = validateParameter('Curtain', 'setPosition', '"50"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('50');
  });

  it('Blind Tilt setPosition: "up;50" (quoted) → accepted', () => {
    const r = validateParameter('Blind Tilt', 'setPosition', '"up;50"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('up;50');
  });

  it('Relay Switch setMode: "1;1" (quoted) → accepted', () => {
    const r = validateParameter('Relay Switch 2PM', 'setMode', '"1;1"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('1;1');
  });

  it('AC setAll: "26,2,2,on" (quoted) → accepted', () => {
    const r = validateParameter('Air Conditioner', 'setAll', '"26,2,2,on"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('26,2,2,on');
  });
});
