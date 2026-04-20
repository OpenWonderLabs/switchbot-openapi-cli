import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';

const apiMock = vi.hoisted(() => {
  const instance = { get: vi.fn(), post: vi.fn() };
  class DryRunSignal extends Error {
    constructor(public readonly method: string, public readonly url: string) {
      super('dry-run');
      this.name = 'DryRunSignal';
    }
  }
  return { createClient: vi.fn(() => instance), __instance: instance, DryRunSignal };
});

vi.mock('../../src/api/client.js', () => ({
  createClient: apiMock.createClient,
  ApiError: class ApiError extends Error {
    constructor(message: string, public readonly code: number) { super(message); this.name = 'ApiError'; }
  },
  DryRunSignal: apiMock.DryRunSignal,
}));

import { registerDevicesCommand } from '../../src/commands/devices.js';
import { runCli } from '../helpers/cli.js';
import { updateCacheFromDeviceList, resetListCache } from '../../src/devices/cache.js';

const AC_ID = 'AC-001';
const CURTAIN_ID = 'CURTAIN-001';
const BLIND_ID = 'BLIND-001';
const RELAY_ID = 'RELAY-001';

const sampleBody = {
  deviceList: [
    { deviceId: CURTAIN_ID, deviceName: 'Living Curtain', deviceType: 'Curtain', hubDeviceId: 'H1', enableCloudService: true },
    { deviceId: BLIND_ID,   deviceName: 'Bedroom Blind',  deviceType: 'Blind Tilt', hubDeviceId: 'H1', enableCloudService: true },
    { deviceId: RELAY_ID,   deviceName: 'Kitchen Switch', deviceType: 'Relay Switch 2PM', hubDeviceId: 'H1', enableCloudService: true },
  ],
  infraredRemoteList: [
    { deviceId: AC_ID, deviceName: 'Living AC', remoteType: 'Air Conditioner', hubDeviceId: 'H1', controlType: 'Air Conditioner' },
  ],
};

describe('devices expand', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(`${os.tmpdir()}/sbcli-expand-`);
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    resetListCache();
    apiMock.__instance.get.mockReset();
    apiMock.__instance.post.mockReset();
    apiMock.createClient.mockReset();
    apiMock.createClient.mockImplementation(() => {
      // Mirror the production client's dry-run interceptor: when --dry-run is
      // in argv, mutating calls throw DryRunSignal without touching the
      // underlying spy (matching the test's expectation that post is never
      // *called through* to the transport in dry-run mode).
      if (process.argv.includes('--dry-run')) {
        return {
          get: apiMock.__instance.get,
          post: async (url: string) => {
            throw new apiMock.DryRunSignal('POST', url);
          },
        };
      }
      return apiMock.__instance;
    });
    apiMock.__instance.post.mockResolvedValue({ data: { body: {} } });
    updateCacheFromDeviceList(sampleBody);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetListCache();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it('translates AC setAll semantic flags to wire format', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'expand', AC_ID, 'setAll',
      '--temp', '26', '--mode', 'cool', '--fan', 'low', '--power', 'on',
    ]);
    expect(res.exitCode).toBe(null);
    expect(apiMock.__instance.post).toHaveBeenCalledWith(
      `/v1.1/devices/${AC_ID}/commands`,
      { command: 'setAll', parameter: '26,2,2,on', commandType: 'command' }
    );
  });

  it('AC: maps all modes correctly', async () => {
    for (const [mode, int] of [['auto','1'],['cool','2'],['dry','3'],['fan','4'],['heat','5']]) {
      apiMock.__instance.post.mockClear();
      await runCli(registerDevicesCommand, [
        'devices', 'expand', AC_ID, 'setAll',
        '--temp', '22', '--mode', mode, '--fan', 'auto', '--power', 'on',
      ]);
      expect(apiMock.__instance.post).toHaveBeenCalledWith(
        `/v1.1/devices/${AC_ID}/commands`,
        { command: 'setAll', parameter: `22,${int},1,on`, commandType: 'command' }
      );
    }
  });

  it('AC: rejects out-of-range temp', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'expand', AC_ID, 'setAll',
      '--temp', '99', '--mode', 'cool', '--fan', 'low', '--power', 'on',
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toMatch(/--temp.*(<= 30|between 16 and 30)/i);
  });

  it('AC: rejects unknown mode', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'expand', AC_ID, 'setAll',
      '--temp', '22', '--mode', 'turbo', '--fan', 'low', '--power', 'on',
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toContain('cool');
  });

  it('translates Curtain setPosition to wire format', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'expand', CURTAIN_ID, 'setPosition',
      '--position', '50', '--mode', 'silent',
    ]);
    expect(res.exitCode).toBe(null);
    expect(apiMock.__instance.post).toHaveBeenCalledWith(
      `/v1.1/devices/${CURTAIN_ID}/commands`,
      { command: 'setPosition', parameter: '0,1,50', commandType: 'command' }
    );
  });

  it('Curtain: default mode uses ff', async () => {
    await runCli(registerDevicesCommand, [
      'devices', 'expand', CURTAIN_ID, 'setPosition', '--position', '30',
    ]);
    expect(apiMock.__instance.post).toHaveBeenCalledWith(
      `/v1.1/devices/${CURTAIN_ID}/commands`,
      { command: 'setPosition', parameter: '0,ff,30', commandType: 'command' }
    );
  });

  it('translates Blind Tilt setPosition to wire format', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'expand', BLIND_ID, 'setPosition',
      '--direction', 'up', '--angle', '50',
    ]);
    expect(res.exitCode).toBe(null);
    expect(apiMock.__instance.post).toHaveBeenCalledWith(
      `/v1.1/devices/${BLIND_ID}/commands`,
      { command: 'setPosition', parameter: 'up;50', commandType: 'command' }
    );
  });

  it('Blind Tilt: rejects invalid direction', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'expand', BLIND_ID, 'setPosition',
      '--direction', 'left', '--angle', '50',
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toContain('up');
  });

  it('translates Relay Switch 2PM setMode to wire format', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'expand', RELAY_ID, 'setMode',
      '--channel', '1', '--mode', 'edge',
    ]);
    expect(res.exitCode).toBe(null);
    expect(apiMock.__instance.post).toHaveBeenCalledWith(
      `/v1.1/devices/${RELAY_ID}/commands`,
      { command: 'setMode', parameter: '1;1', commandType: 'command' }
    );
  });

  it('Relay: rejects invalid channel', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'expand', RELAY_ID, 'setMode',
      '--channel', '3', '--mode', 'edge',
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toMatch(/--channel.*(<= 2|1 or 2)/i);
  });

  it('dry-run does not send the command', async () => {
    await runCli(registerDevicesCommand, [
      'devices', 'expand', CURTAIN_ID, 'setPosition',
      '--position', '50', '--dry-run',
    ]);
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
  });

  it('IR device annotates response with ir-no-feedback in JSON mode', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'expand', AC_ID, 'setAll',
      '--temp', '26', '--mode', 'cool', '--fan', 'low', '--power', 'on', '--json',
    ]);
    const out = JSON.parse(res.stdout.join('\n'));
    expect(out.data.subKind).toBe('ir-no-feedback');
  });

  it('rejects unsupported command', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'expand', CURTAIN_ID, 'turnOn',
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toContain("'expand' does not support");
  });

  it('--name resolves device by fuzzy name', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'expand', '--name', 'Curtain', 'setPosition',
      '--position', '50',
    ]);
    expect(res.exitCode).toBe(null);
    expect(apiMock.__instance.post).toHaveBeenCalledWith(
      `/v1.1/devices/${CURTAIN_ID}/commands`,
      expect.objectContaining({ command: 'setPosition' })
    );
  });
});
