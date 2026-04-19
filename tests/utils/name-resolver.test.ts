import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { resolveDeviceId } from '../../src/utils/name-resolver.js';
import { updateCacheFromDeviceList, resetListCache } from '../../src/devices/cache.js';
import { saveDeviceMeta } from '../../src/devices/device-meta.js';

vi.mock('../../src/utils/flags.js', () => ({ getConfigPath: () => undefined }));

const sampleBody = {
  deviceList: [
    { deviceId: 'LAMP-ABC', deviceName: 'Living Room Lamp', deviceType: 'Color Bulb', hubDeviceId: 'H1', enableCloudService: true },
    { deviceId: 'BOT-001',  deviceName: 'Kitchen Bot',      deviceType: 'Bot',        hubDeviceId: 'H1', enableCloudService: true },
    { deviceId: 'LAMP-XYZ', deviceName: 'Bedroom Lamp',     deviceType: 'Color Bulb', hubDeviceId: 'H1', enableCloudService: true },
  ],
  infraredRemoteList: [
    { deviceId: 'AC-001', deviceName: 'Living AC', remoteType: 'Air Conditioner', hubDeviceId: 'H1' },
  ],
};

describe('resolveDeviceId', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(`${os.tmpdir()}/sbcli-resolver-`);
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    resetListCache();
    updateCacheFromDeviceList(sampleBody);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetListCache();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it('passes through deviceId when provided', () => {
    expect(resolveDeviceId('LAMP-ABC', undefined)).toBe('LAMP-ABC');
  });

  it('throws when both deviceId and name are provided', () => {
    expect(() => resolveDeviceId('LAMP-ABC', 'Living Lamp')).toThrow('both');
  });

  it('throws when neither is provided', () => {
    expect(() => resolveDeviceId(undefined, undefined)).toThrow('required');
  });

  it('resolves by exact name match', () => {
    expect(resolveDeviceId(undefined, 'Kitchen Bot')).toBe('BOT-001');
  });

  it('resolves by case-insensitive exact match', () => {
    expect(resolveDeviceId(undefined, 'kitchen bot')).toBe('BOT-001');
  });

  it('resolves by substring match', () => {
    expect(resolveDeviceId(undefined, 'Kitchen')).toBe('BOT-001');
  });

  it('resolves by fuzzy match (1 typo)', () => {
    expect(resolveDeviceId(undefined, 'Kitchin Bot')).toBe('BOT-001');
  });

  it('throws StructuredUsageError with candidates on ambiguous match', () => {
    let err: Error | null = null;
    try { resolveDeviceId(undefined, 'Lamp'); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('ambiguous');
    // StructuredUsageError should have context with candidates
    const structured = err as { context?: { candidates?: unknown[] } };
    expect(structured.context?.candidates).toBeDefined();
    expect(Array.isArray(structured.context?.candidates)).toBe(true);
  });

  it('throws on no match', () => {
    expect(() => resolveDeviceId(undefined, 'xyzzy-nonexistent')).toThrow('No device matches');
  });

  it('alias takes priority over fuzzy name match', () => {
    saveDeviceMeta({ version: '1', devices: { 'AC-001': { alias: 'Main AC' } } });
    expect(resolveDeviceId(undefined, 'Main AC')).toBe('AC-001');
  });

  it('throws when cache is empty (no devices list run)', () => {
    resetListCache();
    expect(() => resolveDeviceId(undefined, 'anything')).toThrow('devices list');
  });
});
