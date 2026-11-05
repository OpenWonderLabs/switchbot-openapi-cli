import { describe, expect, it } from 'vitest';

import {
  parseParameterForWire,
  validateParameter,
} from '../../src/devices/param-validator.js';

function expectValidLightEffect(effectId: number): void {
  const result = validateParameter(
    'RGBICWW Light Bars',
    'setLightEffect',
    JSON.stringify({ effectId }),
  );

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(parseParameterForWire(result.normalized)).toEqual({ effectId });
}

describe('RGBICWW Light Bars parameter boundaries', () => {
  it('accepts setLightEffect integer boundaries and preserves their JSON wire values', () => {
    expectValidLightEffect(0);
    expectValidLightEffect(25);
  });

  it('rejects setLightEffect values outside its JSON integer contract', () => {
    for (const parameter of [
      '{"effectId":-1}',
      '{"effectId":26}',
      '{"effectId":1.5}',
      '{"effectId":"1"}',
      '{}',
      undefined,
      '[]',
      '{"effectId":',
    ]) {
      expect(validateParameter('RGBICWW Light Bars', 'setLightEffect', parameter).ok).toBe(false);
    }
  });

  it('requires numeric Light Bars object fields while allowing zero brightness', () => {
    const valid = validateParameter(
      'RGBICWW Light Bars',
      'setBrightnessAndTemperature',
      '{"brightness":0,"temperature":2700}',
    );
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error(valid.error);
    expect(parseParameterForWire(valid.normalized)).toEqual({ brightness: 0, temperature: 2700 });

    for (const parameter of [
      { brightness: null, temperature: 2700 },
      { brightness: false, temperature: 2700 },
      { brightness: '0', temperature: 2700 },
      { brightness: 0, temperature: null },
      { brightness: 0, temperature: false },
      { brightness: 0, temperature: '2700' },
    ]) {
      expect(validateParameter(
        'RGBICWW Light Bars',
        'setBrightnessAndTemperature',
        JSON.stringify(parameter),
      ).ok).toBe(false);
    }
  });
});
