import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  loadCache,
  getCachedDevice,
  updateCacheFromDeviceList,
  clearCache,
  listCacheAgeMs,
  isListCacheFresh,
  loadStatusCache,
  getCachedStatus,
  setCachedStatus,
  clearStatusCache,
  describeCache,
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

describe('list cache TTL', () => {
  it('listCacheAgeMs returns null when no cache file exists', () => {
    expect(listCacheAgeMs()).toBeNull();
  });

  it('listCacheAgeMs returns a non-negative age just after write', () => {
    updateCacheFromDeviceList(sampleBody);
    const age = listCacheAgeMs();
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
    expect(age!).toBeLessThan(5_000);
  });

  it('listCacheAgeMs handles corrupt lastUpdated as null', () => {
    const dir = path.join(tmpDir, '.switchbot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'devices.json'),
      JSON.stringify({ lastUpdated: 'not-a-date', devices: {} }),
    );
    expect(listCacheAgeMs()).toBeNull();
  });

  it('isListCacheFresh: ttl=0 means never fresh', () => {
    updateCacheFromDeviceList(sampleBody);
    expect(isListCacheFresh(0)).toBe(false);
  });

  it('isListCacheFresh: fresh when age < ttl', () => {
    updateCacheFromDeviceList(sampleBody);
    expect(isListCacheFresh(60 * 60 * 1000)).toBe(true);
  });

  it('isListCacheFresh: stale when age >= ttl', () => {
    updateCacheFromDeviceList(sampleBody);
    // Rewrite the stored lastUpdated to something old.
    const file = path.join(tmpDir, '.switchbot', 'devices.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.lastUpdated = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(isListCacheFresh(60 * 60 * 1000)).toBe(false);
  });
});

describe('status cache', () => {
  it('loadStatusCache returns empty entries when no file exists', () => {
    expect(loadStatusCache()).toEqual({ entries: {} });
  });

  it('getCachedStatus returns null when ttl is 0 (cache disabled)', () => {
    setCachedStatus('BOT1', { power: 'on' });
    expect(getCachedStatus('BOT1', 0)).toBeNull();
  });

  it('setCachedStatus + getCachedStatus round-trip with live TTL', () => {
    setCachedStatus('BOT1', { power: 'on', battery: 82 });
    const got = getCachedStatus('BOT1', 60_000);
    expect(got).toEqual({ power: 'on', battery: 82 });
  });

  it('getCachedStatus returns null for unknown deviceId', () => {
    setCachedStatus('BOT1', { power: 'on' });
    expect(getCachedStatus('BOT2', 60_000)).toBeNull();
  });

  it('getCachedStatus returns null when entry is older than ttl', () => {
    setCachedStatus('BOT1', { power: 'on' }, new Date(Date.now() - 10 * 60_000));
    expect(getCachedStatus('BOT1', 60_000)).toBeNull();
  });

  it('setCachedStatus overwrites the prior body for the same deviceId', () => {
    setCachedStatus('BOT1', { power: 'on' });
    setCachedStatus('BOT1', { power: 'off', battery: 20 });
    expect(getCachedStatus('BOT1', 60_000)).toEqual({ power: 'off', battery: 20 });
  });

  it('setCachedStatus preserves entries for other devices', () => {
    setCachedStatus('BOT1', { power: 'on' });
    setCachedStatus('BOT2', { power: 'off' });
    expect(getCachedStatus('BOT1', 60_000)).toEqual({ power: 'on' });
    expect(getCachedStatus('BOT2', 60_000)).toEqual({ power: 'off' });
  });

  it('clearStatusCache removes the file but keeps the device list cache', () => {
    updateCacheFromDeviceList(sampleBody);
    setCachedStatus('BOT1', { power: 'on' });
    const statusFile = path.join(tmpDir, '.switchbot', 'status.json');
    const listFile = path.join(tmpDir, '.switchbot', 'devices.json');
    expect(fs.existsSync(statusFile)).toBe(true);
    clearStatusCache();
    expect(fs.existsSync(statusFile)).toBe(false);
    expect(fs.existsSync(listFile)).toBe(true);
  });

  it('clearStatusCache is a no-op when no file exists', () => {
    expect(() => clearStatusCache()).not.toThrow();
  });

  it('loadStatusCache returns empty for malformed JSON', () => {
    const dir = path.join(tmpDir, '.switchbot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'status.json'), '{not json');
    expect(loadStatusCache()).toEqual({ entries: {} });
  });
});

describe('describeCache', () => {
  it('reports both caches as missing on a fresh machine', () => {
    const s = describeCache();
    expect(s.list.exists).toBe(false);
    expect(s.list.deviceCount).toBeUndefined();
    expect(s.status.exists).toBe(false);
    expect(s.status.entryCount).toBe(0);
  });

  it('reports populated list cache age and device count', () => {
    updateCacheFromDeviceList(sampleBody);
    const s = describeCache();
    expect(s.list.exists).toBe(true);
    expect(s.list.deviceCount).toBeGreaterThanOrEqual(3);
    expect(typeof s.list.ageMs).toBe('number');
    expect(s.list.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports oldest/newest status timestamps when populated', () => {
    setCachedStatus('BOT1', { power: 'on' }, new Date('2026-04-01T00:00:00Z'));
    setCachedStatus('BOT2', { power: 'off' }, new Date('2026-04-17T12:00:00Z'));
    const s = describeCache();
    expect(s.status.exists).toBe(true);
    expect(s.status.entryCount).toBe(2);
    expect(s.status.oldestFetchedAt).toBe('2026-04-01T00:00:00.000Z');
    expect(s.status.newestFetchedAt).toBe('2026-04-17T12:00:00.000Z');
  });
});
