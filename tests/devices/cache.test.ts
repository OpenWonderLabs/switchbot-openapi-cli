import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  loadCache,
  getCachedDevice,
  updateCacheFromDeviceList,
  clearCache,
} from '../../src/devices/cache.js';

// Redirect the cache to a test-only temp directory by overriding both
// os.homedir() and --config (cache sits at dirname(config)/devices.json).
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcli-cache-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  process.argv = ['node', 'switchbot'];
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const sampleBody = {
  deviceList: [
    { deviceId: 'PHY-1', deviceName: 'Living Bot', deviceType: 'Bot' },
    { deviceId: 'PHY-2', deviceName: 'Bedroom Bulb', deviceType: 'Color Bulb' },
    { deviceId: 'PHY-3', deviceName: 'AI', deviceType: undefined as unknown as string },
  ],
  infraredRemoteList: [
    { deviceId: 'IR-1', deviceName: 'TV Remote', remoteType: 'TV' },
  ],
};

describe('device cache', () => {
  it('returns null when cache file does not exist', () => {
    expect(loadCache()).toBeNull();
    expect(getCachedDevice('PHY-1')).toBeNull();
  });

  it('writes cache at ~/.switchbot/devices.json after updateCacheFromDeviceList', () => {
    updateCacheFromDeviceList(sampleBody);

    const file = path.join(tmpDir, '.switchbot', 'devices.json');
    expect(fs.existsSync(file)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(raw.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(raw.devices['PHY-1']).toEqual({ type: 'Bot', name: 'Living Bot', category: 'physical' });
    expect(raw.devices['PHY-2']).toEqual({ type: 'Color Bulb', name: 'Bedroom Bulb', category: 'physical' });
    expect(raw.devices['IR-1']).toEqual({ type: 'TV', name: 'TV Remote', category: 'ir' });
  });

  it('skips physical devices without deviceType', () => {
    updateCacheFromDeviceList(sampleBody);
    const cache = loadCache();
    expect(cache?.devices['PHY-3']).toBeUndefined();
  });

  it('getCachedDevice returns cached entry', () => {
    updateCacheFromDeviceList(sampleBody);
    expect(getCachedDevice('PHY-1')).toEqual({ type: 'Bot', name: 'Living Bot', category: 'physical' });
    expect(getCachedDevice('IR-1')).toEqual({ type: 'TV', name: 'TV Remote', category: 'ir' });
    expect(getCachedDevice('missing')).toBeNull();
  });

  it('updateCacheFromDeviceList overwrites stale entries (device removed)', () => {
    updateCacheFromDeviceList(sampleBody);
    expect(getCachedDevice('PHY-1')).not.toBeNull();

    updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'PHY-2', deviceName: 'Bedroom Bulb', deviceType: 'Color Bulb' }],
      infraredRemoteList: [],
    });

    expect(getCachedDevice('PHY-1')).toBeNull();
    expect(getCachedDevice('PHY-2')).not.toBeNull();
    expect(getCachedDevice('IR-1')).toBeNull();
  });

  it('loadCache returns null for malformed JSON', () => {
    const dir = path.join(tmpDir, '.switchbot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'devices.json'), '{not json');
    expect(loadCache()).toBeNull();
  });

  it('loadCache returns null for structurally invalid JSON', () => {
    const dir = path.join(tmpDir, '.switchbot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({ lastUpdated: 'x' }));
    expect(loadCache()).toBeNull();
  });

  it('clearCache removes the cache file when it exists', () => {
    updateCacheFromDeviceList(sampleBody);
    const file = path.join(tmpDir, '.switchbot', 'devices.json');
    expect(fs.existsSync(file)).toBe(true);
    clearCache();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('clearCache is a no-op when the file does not exist', () => {
    expect(() => clearCache()).not.toThrow();
  });

  it('write is atomic with mode 0o600', () => {
    updateCacheFromDeviceList(sampleBody);
    const file = path.join(tmpDir, '.switchbot', 'devices.json');
    const stat = fs.statSync(file);
    // On Windows mode bits don't fully reflect POSIX perms, so just check writeable
    expect((stat.mode & 0o777).toString(8)).toMatch(/^6/);
  });

  it('honors --config override: cache sits next to the config file', () => {
    const custom = path.join(tmpDir, 'alt', 'cfg.json');
    fs.mkdirSync(path.dirname(custom), { recursive: true });
    process.argv = ['node', 'switchbot', '--config', custom];

    updateCacheFromDeviceList(sampleBody);

    const expected = path.join(tmpDir, 'alt', 'devices.json');
    expect(fs.existsSync(expected)).toBe(true);
    // Default path should NOT have been created.
    expect(fs.existsSync(path.join(tmpDir, '.switchbot', 'devices.json'))).toBe(false);
  });
});
