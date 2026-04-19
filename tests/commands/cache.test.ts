import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { registerCacheCommand } from '../../src/commands/cache.js';
import {
  updateCacheFromDeviceList,
  setCachedStatus,
  resetListCache,
  resetStatusCache,
} from '../../src/devices/cache.js';
import { runCli } from '../helpers/cli.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcli-cachecmd-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  resetListCache();
  resetStatusCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetListCache();
  resetStatusCache();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

const SAMPLE_BODY = {
  deviceList: [
    { deviceId: 'BOT1', deviceName: 'Kitchen', deviceType: 'Bot' },
    { deviceId: 'BULB1', deviceName: 'Desk', deviceType: 'Color Bulb' },
  ],
  infraredRemoteList: [
    { deviceId: 'IR1', deviceName: 'TV', remoteType: 'TV' },
  ],
};

describe('cache show', () => {
  it('prints empty summaries on a fresh machine', async () => {
    const result = await runCli(registerCacheCommand, ['cache', 'show']);
    expect(result.exitCode).toBeNull();
    const out = result.stdout.join('\n');
    expect(out).toMatch(/Device list cache/);
    expect(out).toMatch(/Exists:\s+no/);
    expect(out).toMatch(/Status cache/);
    expect(out).toMatch(/Entries:\s+0/);
  });

  it('reports list cache age + device count when populated', async () => {
    updateCacheFromDeviceList(SAMPLE_BODY);
    const result = await runCli(registerCacheCommand, ['cache', 'show']);
    expect(result.exitCode).toBeNull();
    const out = result.stdout.join('\n');
    expect(out).toMatch(/Device list cache/);
    expect(out).toMatch(/Exists:\s+yes/);
    expect(out).toMatch(/Devices:\s+3/);
    expect(out).toMatch(/Age:/);
  });

  it('reports status cache entry count + oldest/newest', async () => {
    // Both timestamps must be within 24 h of the newer `now` so GC doesn't evict the older entry.
    setCachedStatus('BOT1', { power: 'on' }, new Date('2026-04-17T10:00:00Z'));
    setCachedStatus('BOT2', { power: 'off' }, new Date('2026-04-17T12:00:00Z'));
    const result = await runCli(registerCacheCommand, ['cache', 'show']);
    expect(result.exitCode).toBeNull();
    const out = result.stdout.join('\n');
    expect(out).toMatch(/Entries:\s+2/);
    expect(out).toMatch(/Oldest:\s+2026-04-17T10:00:00\.000Z/);
    expect(out).toMatch(/Newest:\s+2026-04-17T12:00:00\.000Z/);
  });

  it('--json emits a single machine-readable object', async () => {
    updateCacheFromDeviceList(SAMPLE_BODY);
    setCachedStatus('BOT1', { power: 'on' }, new Date('2026-04-17T12:00:00Z'));
    const result = await runCli(registerCacheCommand, ['--json', 'cache', 'show']);
    expect(result.exitCode).toBeNull();
    const parsed = JSON.parse(result.stdout.join('\n'));
    expect(parsed.list.exists).toBe(true);
    expect(parsed.list.deviceCount).toBe(3);
    expect(parsed.status.entryCount).toBe(1);
    expect(parsed.status.entries.BOT1.fetchedAt).toBe('2026-04-17T12:00:00.000Z');
    // --json output should not leak the raw status body (only timestamps).
    expect(parsed.status.entries.BOT1.body).toBeUndefined();
  });
});

describe('cache clear', () => {
  it('default clears both list and status caches', async () => {
    updateCacheFromDeviceList(SAMPLE_BODY);
    setCachedStatus('BOT1', { power: 'on' });

    const listFile = path.join(tmpHome, '.switchbot', 'devices.json');
    const statusFile = path.join(tmpHome, '.switchbot', 'status.json');
    expect(fs.existsSync(listFile)).toBe(true);
    expect(fs.existsSync(statusFile)).toBe(true);

    const result = await runCli(registerCacheCommand, ['cache', 'clear']);
    expect(result.exitCode).toBeNull();
    expect(fs.existsSync(listFile)).toBe(false);
    expect(fs.existsSync(statusFile)).toBe(false);
    expect(result.stdout.join('\n')).toMatch(/Cleared:.*list.*status/);
  });

  it('--key list removes only devices.json', async () => {
    updateCacheFromDeviceList(SAMPLE_BODY);
    setCachedStatus('BOT1', { power: 'on' });

    const listFile = path.join(tmpHome, '.switchbot', 'devices.json');
    const statusFile = path.join(tmpHome, '.switchbot', 'status.json');

    const result = await runCli(registerCacheCommand, ['cache', 'clear', '--key', 'list']);
    expect(result.exitCode).toBeNull();
    expect(fs.existsSync(listFile)).toBe(false);
    expect(fs.existsSync(statusFile)).toBe(true);
  });

  it('--key status removes only status.json', async () => {
    updateCacheFromDeviceList(SAMPLE_BODY);
    setCachedStatus('BOT1', { power: 'on' });

    const listFile = path.join(tmpHome, '.switchbot', 'devices.json');
    const statusFile = path.join(tmpHome, '.switchbot', 'status.json');

    const result = await runCli(registerCacheCommand, ['cache', 'clear', '--key', 'status']);
    expect(result.exitCode).toBeNull();
    expect(fs.existsSync(listFile)).toBe(true);
    expect(fs.existsSync(statusFile)).toBe(false);
  });

  it('rejects unknown --key with exit 2', async () => {
    const result = await runCli(registerCacheCommand, ['cache', 'clear', '--key', 'bogus']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.join('\n')).toMatch(/Unknown --key/);
  });

  it('--json reports which caches were cleared', async () => {
    updateCacheFromDeviceList(SAMPLE_BODY);
    const result = await runCli(registerCacheCommand, ['--json', 'cache', 'clear', '--key', 'list']);
    expect(result.exitCode).toBeNull();
    const parsed = JSON.parse(result.stdout.join('\n'));
    expect(parsed).toEqual({ cleared: ['list'] });
  });

  it('is a no-op when files do not exist', async () => {
    const result = await runCli(registerCacheCommand, ['cache', 'clear']);
    expect(result.exitCode).toBeNull();
    expect(result.stdout.join('\n')).toMatch(/Cleared/);
  });
});
