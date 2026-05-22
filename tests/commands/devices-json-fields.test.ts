import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerDevicesCommand } from '../../src/commands/devices.js';
import { runCli } from '../helpers/cli.js';

const { fetchDeviceListMock } = vi.hoisted(() => ({
  fetchDeviceListMock: vi.fn(),
}));

vi.mock('../../src/lib/devices.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/devices.js')>(
    '../../src/lib/devices.js',
  );
  return {
    ...actual,
    fetchDeviceList: (...args: unknown[]) => fetchDeviceListMock(...args),
  };
});

vi.mock('../../src/devices/cache.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/devices/cache.js')>(
    '../../src/devices/cache.js',
  );
  return { ...actual, isListCacheFresh: vi.fn().mockReturnValue(false) };
});

let tmpHome: string;

beforeEach(() => {
  fetchDeviceListMock.mockReset();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcli-devjson-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('devices list --json --fields cloud', () => {
  it('emits cloud as a boolean for physical devices (not a string)', async () => {
    fetchDeviceListMock.mockResolvedValue({
      deviceList: [
        { deviceId: 'DEV1', deviceName: 'Bot', deviceType: 'Bot', enableCloudService: true, hubDeviceId: '' },
        { deviceId: 'DEV2', deviceName: 'Plug', deviceType: 'Plug Mini (US)', enableCloudService: false, hubDeviceId: '' },
      ],
      infraredRemoteList: [],
    });

    const res = await runCli(registerDevicesCommand, [
      '--json', '--fields', 'deviceId,cloud',
      'devices', 'list',
    ]);

    expect(res.exitCode).toBeNull();
    const parsed = JSON.parse(res.stdout.join('\n')) as Record<string, unknown>;
    const data = (parsed['data'] ?? parsed) as Record<string, unknown>;
    const list = data['deviceList'] as Array<{ cloud: unknown }>;
    expect(list).toHaveLength(2);
    // cloud must be boolean, not string
    expect(list[0].cloud).toBe(true);
    expect(list[1].cloud).toBe(false);
    expect(typeof list[0].cloud).toBe('boolean');
  });

  it('emits cloud as null for IR remotes (not the dash string "—")', async () => {
    fetchDeviceListMock.mockResolvedValue({
      deviceList: [],
      infraredRemoteList: [
        { deviceId: 'IR1', deviceName: 'TV', remoteType: 'TV', hubDeviceId: 'HUB1', controlType: 'TV' },
      ],
    });

    const res = await runCli(registerDevicesCommand, [
      '--json', '--fields', 'deviceId,cloud',
      'devices', 'list',
    ]);

    expect(res.exitCode).toBeNull();
    const parsed = JSON.parse(res.stdout.join('\n')) as Record<string, unknown>;
    const data = (parsed['data'] ?? parsed) as Record<string, unknown>;
    const irList = data['infraredRemoteList'] as Array<{ cloud: unknown }>;
    expect(irList).toHaveLength(1);
    // cloud must be null for IR remotes, not '—'
    expect(irList[0].cloud).toBeNull();
  });
});
