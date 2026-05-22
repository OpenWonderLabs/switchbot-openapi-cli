import { describe, it, expect } from 'vitest';
import { DEVICE_FIELD_ALIAS, DEVICE_ALL_COLS } from '../../src/commands/devices-columns.js';

describe('devices — column constants', () => {
  it('DEVICE_FIELD_ALIAS maps "id" to "deviceId"', () => {
    expect(DEVICE_FIELD_ALIAS['id']).toBe('deviceId');
  });

  it('DEVICE_FIELD_ALIAS maps "name" to "deviceName"', () => {
    expect(DEVICE_FIELD_ALIAS['name']).toBe('deviceName');
  });

  it('DEVICE_ALL_COLS contains expected canonical columns', () => {
    for (const col of ['deviceId', 'deviceName', 'type', 'category', 'hub', 'cloud']) {
      expect(DEVICE_ALL_COLS.has(col)).toBe(true);
    }
  });

  it('DEVICE_ALL_COLS has 11 entries', () => {
    expect(DEVICE_ALL_COLS.size).toBe(11);
  });
});
