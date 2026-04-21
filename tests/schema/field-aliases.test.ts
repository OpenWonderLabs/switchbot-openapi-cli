import { describe, it, expect } from 'vitest';
import {
  FIELD_ALIASES,
  resolveField,
  resolveFieldList,
  listSupportedFieldInputs,
  listAllCanonical,
} from '../../src/schema/field-aliases.js';

describe('FIELD_ALIASES registry', () => {
  it('has at least ~51 canonical keys after P14 expansion', () => {
    expect(Object.keys(FIELD_ALIASES).length).toBeGreaterThanOrEqual(51);
  });

  it('never uses reserved/too-generic words as aliases (beyond the grandfathered "type"→deviceType)', () => {
    // `type` is grandfathered on deviceType from the identification tier — it predates
    // P1's expansion and is already consumed by list-filter parsing. Other reserved
    // words are still banned so Phase 2+ fields don't accidentally collide with them.
    const forbidden = new Set(['auto', 'status', 'state', 'switch', 'on', 'off', 'lock', 'fan']);
    for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
      for (const a of aliases) {
        expect(forbidden.has(a.toLowerCase()), `"${a}" (under ${canonical}) must not be an alias — it is reserved/too-generic`).toBe(false);
      }
    }
  });

  it('has no duplicate aliases across canonical keys', () => {
    const seen = new Map<string, string>();
    for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
      for (const a of aliases) {
        const existing = seen.get(a.toLowerCase());
        expect(existing, `alias "${a}" appears under both "${existing}" and "${canonical}"`).toBeUndefined();
        seen.set(a.toLowerCase(), canonical);
      }
    }
  });

  it('"temp" resolves only to temperature (not colorTemperature / targetTemperature)', () => {
    expect(resolveField('temp', ['temperature', 'colorTemperature', 'targetTemperature'])).toBe('temperature');
  });

  it('"motion" resolves only to moveDetected (not moving)', () => {
    expect(resolveField('motion', ['moveDetected', 'moving'])).toBe('moveDetected');
  });

  it('"active" resolves only to moving', () => {
    expect(resolveField('active', ['moveDetected', 'moving'])).toBe('moving');
  });

  it('"mode" maps to canonical mode, "devmode" maps to deviceMode', () => {
    expect(resolveField('mode', ['mode', 'deviceMode'])).toBe('mode');
    expect(resolveField('devmode', ['mode', 'deviceMode'])).toBe('deviceMode');
  });

  it('"preset" resolves to mode', () => {
    expect(resolveField('preset', ['mode'])).toBe('mode');
  });

  it('"kelvin" / "colortemp" resolve to colorTemperature (never to temperature)', () => {
    expect(resolveField('kelvin', ['temperature', 'colorTemperature'])).toBe('colorTemperature');
    expect(resolveField('colortemp', ['temperature', 'colorTemperature'])).toBe('colorTemperature');
  });

  it('"enabled" resolves to power (on is not an alias — would conflict with the command)', () => {
    expect(resolveField('enabled', ['power'])).toBe('power');
    expect(() => resolveField('on', ['power'])).toThrow(/Unknown/i);
  });
});

describe('resolveField() — Phase 1 aliases', () => {
  it('battery: batt, bat', () => {
    for (const a of ['batt', 'bat', 'BATT', 'Battery']) {
      expect(resolveField(a, ['battery'])).toBe('battery');
    }
  });

  it('humidity: humid, rh', () => {
    expect(resolveField('humid', ['humidity'])).toBe('humidity');
    expect(resolveField('rh', ['humidity'])).toBe('humidity');
  });

  it('brightness: bright, bri', () => {
    expect(resolveField('bright', ['brightness'])).toBe('brightness');
    expect(resolveField('bri', ['brightness'])).toBe('brightness');
  });

  it('fanSpeed: speed (not fan)', () => {
    expect(resolveField('speed', ['fanSpeed'])).toBe('fanSpeed');
    expect(() => resolveField('fan', ['fanSpeed'])).toThrow(/Unknown/i);
  });

  it('openState: open (not state)', () => {
    expect(resolveField('open', ['openState'])).toBe('openState');
    expect(() => resolveField('state', ['openState'])).toThrow(/Unknown/i);
  });

  it('doorState: door', () => {
    expect(resolveField('door', ['doorState'])).toBe('doorState');
  });

  it('position: pos', () => {
    expect(resolveField('pos', ['position'])).toBe('position');
  });

  it('CO2: co2 (case-insensitive)', () => {
    expect(resolveField('co2', ['CO2'])).toBe('CO2');
    expect(resolveField('CO2', ['CO2'])).toBe('CO2');
  });
});

describe('resolveField() — Phase 2 aliases', () => {
  it('childLock: safe, childlock (never lock)', () => {
    expect(resolveField('safe', ['childLock'])).toBe('childLock');
    expect(resolveField('childlock', ['childLock'])).toBe('childLock');
    expect(() => resolveField('lock', ['childLock'])).toThrow(/Unknown/i);
  });

  it('targetTemperature: setpoint, target (not temp)', () => {
    expect(resolveField('setpoint', ['targetTemperature'])).toBe('targetTemperature');
    expect(resolveField('target', ['targetTemperature'])).toBe('targetTemperature');
  });

  it('electricCurrent: current, amps', () => {
    expect(resolveField('current', ['electricCurrent'])).toBe('electricCurrent');
    expect(resolveField('amps', ['electricCurrent'])).toBe('electricCurrent');
  });

  it('voltage: volts', () => {
    expect(resolveField('volts', ['voltage'])).toBe('voltage');
  });

  it('usedElectricity: energy, kwh', () => {
    expect(resolveField('energy', ['usedElectricity'])).toBe('usedElectricity');
    expect(resolveField('kwh', ['usedElectricity'])).toBe('usedElectricity');
  });

  it('electricityOfDay: daily, today', () => {
    expect(resolveField('daily', ['electricityOfDay'])).toBe('electricityOfDay');
    expect(resolveField('today', ['electricityOfDay'])).toBe('electricityOfDay');
  });

  it('version: firmware, fw', () => {
    expect(resolveField('firmware', ['version'])).toBe('version');
    expect(resolveField('fw', ['version'])).toBe('version');
  });

  it('lightLevel: light, lux', () => {
    expect(resolveField('light', ['lightLevel'])).toBe('lightLevel');
    expect(resolveField('lux', ['lightLevel'])).toBe('lightLevel');
  });

  it('oscillation / verticalOscillation resolve separately', () => {
    expect(resolveField('swing', ['oscillation', 'verticalOscillation'])).toBe('oscillation');
    expect(resolveField('vswing', ['oscillation', 'verticalOscillation'])).toBe('verticalOscillation');
  });

  it('chargingStatus: charging, charge', () => {
    expect(resolveField('charging', ['chargingStatus'])).toBe('chargingStatus');
    expect(resolveField('charge', ['chargingStatus'])).toBe('chargingStatus');
  });

  it('switch1Status / switch2Status: ch1 / ch2', () => {
    expect(resolveField('ch1', ['switch1Status', 'switch2Status'])).toBe('switch1Status');
    expect(resolveField('ch2', ['switch1Status', 'switch2Status'])).toBe('switch2Status');
    expect(resolveField('channel1', ['switch1Status'])).toBe('switch1Status');
  });

  it('taskType: task (not type)', () => {
    expect(resolveField('task', ['taskType'])).toBe('taskType');
    expect(() => resolveField('type', ['taskType'])).toThrow(/Unknown/i);
  });
});

describe('resolveField() — Phase 3 aliases', () => {
  it('group: cluster', () => {
    expect(resolveField('cluster', ['group'])).toBe('group');
  });

  it('calibrate: calibration, calib', () => {
    expect(resolveField('calibration', ['calibrate'])).toBe('calibrate');
    expect(resolveField('calib', ['calibrate'])).toBe('calibrate');
  });

  it('direction: tilt', () => {
    expect(resolveField('tilt', ['direction'])).toBe('direction');
  });

  it('nebulizationEfficiency: mist, spray', () => {
    expect(resolveField('mist', ['nebulizationEfficiency'])).toBe('nebulizationEfficiency');
    expect(resolveField('spray', ['nebulizationEfficiency'])).toBe('nebulizationEfficiency');
  });

  it('lackWater: tank, water-low', () => {
    expect(resolveField('tank', ['lackWater'])).toBe('lackWater');
    expect(resolveField('water-low', ['lackWater'])).toBe('lackWater');
  });

  it('color: rgb, hex', () => {
    expect(resolveField('rgb', ['color'])).toBe('color');
    expect(resolveField('hex', ['color'])).toBe('color');
  });

  it('useTime: runtime, uptime', () => {
    expect(resolveField('runtime', ['useTime'])).toBe('useTime');
    expect(resolveField('uptime', ['useTime'])).toBe('useTime');
  });

  it('switchStatus: relay (not switch)', () => {
    expect(resolveField('relay', ['switchStatus'])).toBe('switchStatus');
    expect(() => resolveField('switch', ['switchStatus'])).toThrow(/Unknown/i);
  });

  it('lockState: locked', () => {
    expect(resolveField('locked', ['lockState'])).toBe('lockState');
  });

  it('slidePosition: slide', () => {
    expect(resolveField('slide', ['slidePosition'])).toBe('slidePosition');
  });

  it('sound: audio', () => {
    expect(resolveField('audio', ['sound'])).toBe('sound');
  });

  it('filterElement: filter', () => {
    expect(resolveField('filter', ['filterElement'])).toBe('filterElement');
  });
});

describe('resolveField() — Phase 4 aliases (ultra-niche)', () => {
  it('waterLeakDetect: leak, water', () => {
    expect(resolveField('leak', ['waterLeakDetect'])).toBe('waterLeakDetect');
    expect(resolveField('water', ['waterLeakDetect'])).toBe('waterLeakDetect');
  });

  it('pressure: press, pa', () => {
    expect(resolveField('press', ['pressure'])).toBe('pressure');
    expect(resolveField('pa', ['pressure'])).toBe('pressure');
  });

  it('moveCount: movecnt', () => {
    expect(resolveField('movecnt', ['moveCount'])).toBe('moveCount');
  });

  it('errorCode: err', () => {
    expect(resolveField('err', ['errorCode'])).toBe('errorCode');
  });

  it('buttonName: btn, button', () => {
    expect(resolveField('btn', ['buttonName'])).toBe('buttonName');
    expect(resolveField('button', ['buttonName'])).toBe('buttonName');
  });

  it('pressedAt: pressed (distinct from pressure.press)', () => {
    expect(resolveField('pressed', ['pressedAt'])).toBe('pressedAt');
    // `press` goes to pressure, not pressedAt
    expect(resolveField('press', ['pressure', 'pressedAt'])).toBe('pressure');
  });

  it('deviceMac: mac', () => {
    expect(resolveField('mac', ['deviceMac'])).toBe('deviceMac');
  });

  it('detectionState: detected, detect', () => {
    expect(resolveField('detected', ['detectionState'])).toBe('detectionState');
    expect(resolveField('detect', ['detectionState'])).toBe('detectionState');
  });
});

describe('resolveField() — error paths', () => {
  it('throws on empty input', () => {
    expect(() => resolveField('', ['battery'])).toThrow(/empty/i);
    expect(() => resolveField('   ', ['battery'])).toThrow(/empty/i);
  });

  it('throws on unknown field with candidate list', () => {
    let err: Error | null = null;
    try { resolveField('zombie', ['battery', 'humidity']); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('zombie');
    expect(err!.message).toContain('battery');
    expect(err!.message).toContain('humidity');
  });

  it('does not resolve an alias whose canonical is not in the allowed list', () => {
    // `batt` would map to `battery`, but `battery` is not allowed here.
    expect(() => resolveField('batt', ['humidity', 'CO2'])).toThrow(/Unknown/i);
  });

  it('prefers direct canonical match over alias match when both possible', () => {
    // Edge: if someone registered an alias that matched another canonical name,
    // the canonical check runs first so we never return the aliased-canonical.
    expect(resolveField('battery', ['battery', 'humidity'])).toBe('battery');
  });
});

describe('resolveFieldList()', () => {
  it('resolves a list of mixed alias + canonical inputs', () => {
    expect(resolveFieldList(['batt', 'humid', 'power'], ['battery', 'humidity', 'power']))
      .toEqual(['battery', 'humidity', 'power']);
  });

  it('preserves input order', () => {
    expect(resolveFieldList(['power', 'batt'], ['battery', 'power']))
      .toEqual(['power', 'battery']);
  });

  it('throws on first unknown input', () => {
    expect(() => resolveFieldList(['batt', 'zombie', 'humid'], ['battery', 'humidity']))
      .toThrow(/zombie/);
  });
});

describe('listSupportedFieldInputs() / listAllCanonical()', () => {
  it('lists canonicals + their aliases for the allowed subset', () => {
    const out = listSupportedFieldInputs(['battery', 'humidity']);
    expect(out).toContain('battery');
    expect(out).toContain('batt');
    expect(out).toContain('humidity');
    expect(out).toContain('rh');
  });

  it('listAllCanonical returns every canonical in the registry', () => {
    const all = listAllCanonical();
    expect(all).toContain('deviceId');
    expect(all).toContain('battery');
    expect(all).toContain('switchStatus');
    expect(all.length).toBe(Object.keys(FIELD_ALIASES).length);
  });
});
