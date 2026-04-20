import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { registerDevicesCommand } from '../../src/commands/devices.js';
import { runCli } from '../helpers/cli.js';
import { updateCacheFromDeviceList, resetListCache } from '../../src/devices/cache.js';

vi.mock('../../src/api/client.js', () => ({
  createClient: vi.fn(() => ({ get: vi.fn(), post: vi.fn() })),
  ApiError: class ApiError extends Error {
    constructor(message: string, public readonly code: number) { super(message); this.name = 'ApiError'; }
  },
  DryRunSignal: class DryRunSignal extends Error { constructor() { super('dry-run'); this.name = 'DryRunSignal'; } },
}));

const sampleBody = {
  deviceList: [
    { deviceId: 'LAMP-1', deviceName: 'Living Lamp',  deviceType: 'Color Bulb', hubDeviceId: 'H1', enableCloudService: true },
    { deviceId: 'LAMP-2', deviceName: 'Kitchen Lamp', deviceType: 'Color Bulb', hubDeviceId: 'H1', enableCloudService: true },
    { deviceId: 'TEST-1', deviceName: 'test device',  deviceType: 'Bot',        hubDeviceId: 'H1', enableCloudService: false },
  ],
  infraredRemoteList: [],
};

describe('devices meta', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(`${os.tmpdir()}/sbcli-meta-`);
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    resetListCache();
    updateCacheFromDeviceList(sampleBody);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetListCache();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it('meta set creates alias entry', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'meta', 'set', 'LAMP-1', '--alias', '客厅灯',
    ]);
    expect(res.exitCode).toBe(null);
    expect(res.stdout.join('\n')).toContain('LAMP-1');
  });

  it('meta get returns entry', async () => {
    await runCli(registerDevicesCommand, ['devices', 'meta', 'set', 'LAMP-1', '--alias', 'My Lamp']);
    const res = await runCli(registerDevicesCommand, ['devices', 'meta', 'get', 'LAMP-1']);
    expect(res.stdout.join('\n')).toContain('My Lamp');
  });

  it('meta get returns nothing for unknown device', async () => {
    const res = await runCli(registerDevicesCommand, ['devices', 'meta', 'get', 'UNKNOWN']);
    expect(res.stdout.join('\n')).toContain('No local metadata');
  });

  it('meta set --hide / --show cannot be combined', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'meta', 'set', 'LAMP-1', '--hide', '--show',
    ]);
    expect(res.exitCode).toBe(2);
  });

  it('meta list shows all entries', async () => {
    await runCli(registerDevicesCommand, ['devices', 'meta', 'set', 'LAMP-1', '--alias', 'L1']);
    await runCli(registerDevicesCommand, ['devices', 'meta', 'set', 'LAMP-2', '--alias', 'L2']);
    const res = await runCli(registerDevicesCommand, ['devices', 'meta', 'list']);
    const out = res.stdout.join('\n');
    expect(out).toContain('LAMP-1');
    expect(out).toContain('LAMP-2');
  });

  it('meta clear removes entry', async () => {
    await runCli(registerDevicesCommand, ['devices', 'meta', 'set', 'LAMP-1', '--alias', 'X']);
    await runCli(registerDevicesCommand, ['devices', 'meta', 'clear', 'LAMP-1']);
    const res = await runCli(registerDevicesCommand, ['devices', 'meta', 'get', 'LAMP-1']);
    expect(res.stdout.join('\n')).toContain('No local metadata');
  });

  it('setting alias on device B (without --force) when device A already holds it → exit 2 mentioning device A (bug #41)', async () => {
    await runCli(registerDevicesCommand, ['devices', 'meta', 'set', 'LAMP-1', '--alias', 'myAlias']);
    const res = await runCli(registerDevicesCommand, ['devices', 'meta', 'set', 'LAMP-2', '--alias', 'myAlias']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toContain('LAMP-1');
  });

  it('--force reassigns alias from device A to device B and clears A (bug #41)', async () => {
    await runCli(registerDevicesCommand, ['devices', 'meta', 'set', 'LAMP-1', '--alias', 'myAlias']);
    const res = await runCli(registerDevicesCommand, ['devices', 'meta', 'set', 'LAMP-2', '--alias', 'myAlias', '--force']);
    expect(res.exitCode).toBeNull();
    // LAMP-1 should have no alias now
    const lamp1 = await runCli(registerDevicesCommand, ['devices', 'meta', 'get', 'LAMP-1']);
    expect(lamp1.stdout.join('\n')).not.toContain('myAlias');
    // LAMP-2 should hold the alias
    const lamp2 = await runCli(registerDevicesCommand, ['devices', 'meta', 'get', 'LAMP-2']);
    expect(lamp2.stdout.join('\n')).toContain('myAlias');
  });

  it('re-asserting the same alias on the same device is a no-op (no conflict with self, bug #41)', async () => {
    await runCli(registerDevicesCommand, ['devices', 'meta', 'set', 'LAMP-1', '--alias', 'myAlias']);
    const res = await runCli(registerDevicesCommand, ['devices', 'meta', 'set', 'LAMP-1', '--alias', 'myAlias']);
    expect(res.exitCode).toBeNull();
  });
});
