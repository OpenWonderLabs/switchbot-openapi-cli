import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiMock = vi.hoisted(() => {
  const instance = { get: vi.fn(), post: vi.fn() };
  return {
    createClient: vi.fn(() => instance),
    __instance: instance,
    DryRunSignal: class DryRunSignal extends Error {
      constructor(public readonly method: string, public readonly url: string) {
        super('dry-run');
        this.name = 'DryRunSignal';
      }
    },
  };
});

vi.mock('../../src/api/client.js', () => ({
  createClient: apiMock.createClient,
  ApiError: class ApiError extends Error {
    constructor(message: string, public readonly code: number) {
      super(message);
      this.name = 'ApiError';
    }
  },
  DryRunSignal: apiMock.DryRunSignal,
}));

// Cache: keep deterministic across tests.
const cacheMock = vi.hoisted(() => ({
  map: new Map<string, { type: string; name: string; category: 'physical' | 'ir' }>(),
  getCachedDevice: vi.fn((id: string) => cacheMock.map.get(id) ?? null),
  getCachedTypeMap: vi.fn((ids?: Iterable<string>) => {
    const out = new Map<string, string>();
    if (!ids) return out;
    for (const id of ids) {
      const entry = cacheMock.map.get(id);
      if (entry?.type) out.set(id, entry.type);
    }
    return out;
  }),
  updateCacheFromDeviceList: vi.fn(),
}));
vi.mock('../../src/devices/cache.js', () => ({
  getCachedDevice: cacheMock.getCachedDevice,
  getCachedTypeMap: cacheMock.getCachedTypeMap,
  updateCacheFromDeviceList: cacheMock.updateCacheFromDeviceList,
  loadCache: vi.fn(() => null),
  clearCache: vi.fn(),
  isListCacheFresh: vi.fn(() => false),
  listCacheAgeMs: vi.fn(() => null),
  getCachedStatus: vi.fn(() => null),
  setCachedStatus: vi.fn(),
  clearStatusCache: vi.fn(),
  resetStatusCache: vi.fn(),
  loadStatusCache: vi.fn(() => ({ entries: {} })),
  describeCache: vi.fn(() => ({
    list: { path: '', exists: false },
    status: { path: '', exists: false, entryCount: 0 },
  })),
}));

// Flags: dryRun toggleable per test.
const flagsMock = vi.hoisted(() => ({
  dryRun: false,
  isDryRun: vi.fn(() => flagsMock.dryRun),
  isVerbose: vi.fn(() => false),
  getTimeout: vi.fn(() => 30000),
  getConfigPath: vi.fn(() => undefined),
  getProfile: vi.fn(() => undefined),
  getAuditLog: vi.fn(() => null),
  getCacheMode: vi.fn(() => ({ listTtlMs: 0, statusTtlMs: 0 })),
  getFormat: vi.fn(() => undefined),
  getFields: vi.fn(() => undefined),
}));
vi.mock('../../src/utils/flags.js', () => flagsMock);

import { registerDevicesCommand } from '../../src/commands/devices.js';
import { runCli } from '../helpers/cli.js';

const DEVICE_LIST_BODY = {
  deviceList: [
    {
      deviceId: 'BOT1',
      deviceName: 'Kitchen',
      deviceType: 'Bot',
      familyName: 'Home',
      roomName: 'Kitchen',
      enableCloudService: true,
      hubDeviceId: 'HUB1',
    },
    {
      deviceId: 'BOT2',
      deviceName: 'Office',
      deviceType: 'Bot',
      familyName: 'Home',
      roomName: 'Office',
      enableCloudService: true,
      hubDeviceId: 'HUB1',
    },
    {
      deviceId: 'LOCK1',
      deviceName: 'Front',
      deviceType: 'Smart Lock',
      familyName: 'Home',
      roomName: 'Entry',
      enableCloudService: true,
      hubDeviceId: 'HUB1',
    },
  ],
  infraredRemoteList: [],
};

describe('devices batch', () => {
  beforeEach(() => {
    apiMock.__instance.get.mockReset();
    apiMock.__instance.post.mockReset();
    apiMock.createClient.mockClear();
    cacheMock.map.clear();
    cacheMock.getCachedDevice.mockClear();
    cacheMock.getCachedTypeMap.mockClear();
    flagsMock.dryRun = false;
  });

  it('refuses to run without --ids / --filter / stdin', async () => {
    const result = await runCli(registerDevicesCommand, ['devices', 'batch', 'turnOn']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.join('\n')).toMatch(/No target devices/);
  });

  it('rejects an unknown filter key', async () => {
    apiMock.__instance.get.mockResolvedValue({ data: { statusCode: 100, body: DEVICE_LIST_BODY } });
    const result = await runCli(registerDevicesCommand, [
      'devices',
      'batch',
      'turnOn',
      '--filter',
      'color=red',
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.join('\n')).toMatch(/Unknown filter key/);
  });

  it('dispatches turnOn to every device selected by --filter', async () => {
    apiMock.__instance.get.mockResolvedValue({ data: { statusCode: 100, body: DEVICE_LIST_BODY } });
    apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });

    const result = await runCli(registerDevicesCommand, [
      '--json',
      'devices',
      'batch',
      'turnOn',
      '--filter',
      'type=Bot',
    ]);

    expect(result.exitCode).toBeNull();
    expect(apiMock.__instance.post).toHaveBeenCalledTimes(2);
    const parsed = JSON.parse(result.stdout[0]);
    expect(parsed.summary.ok).toBe(2);
    expect(parsed.summary.failed).toBe(0);
    expect(parsed.succeeded.map((s: { deviceId: string }) => s.deviceId).sort()).toEqual(['BOT1', 'BOT2']);
  });

  it('dispatches by --ids (intersected with --filter when both are set)', async () => {
    apiMock.__instance.get.mockResolvedValue({ data: { statusCode: 100, body: DEVICE_LIST_BODY } });
    apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });

    const result = await runCli(registerDevicesCommand, [
      '--json',
      'devices',
      'batch',
      'turnOn',
      '--ids',
      'BOT1,BOT2,LOCK1',
      '--filter',
      'type=Bot',
    ]);

    expect(result.exitCode).toBeNull();
    // Only BOT1 and BOT2 pass the filter — LOCK1 is excluded.
    expect(apiMock.__instance.post).toHaveBeenCalledTimes(2);
    const parsed = JSON.parse(result.stdout[0]);
    expect(parsed.summary.total).toBe(2);
  });

  it('uses cached type info for --ids without fetching the device list', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'Kitchen', category: 'physical' });
    cacheMock.map.set('BOT2', { type: 'Bot', name: 'Office', category: 'physical' });
    apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });

    const result = await runCli(registerDevicesCommand, [
      '--json',
      'devices',
      'batch',
      'turnOn',
      '--ids',
      'BOT1,BOT2',
    ]);

    expect(result.exitCode).toBeNull();
    expect(apiMock.__instance.get).not.toHaveBeenCalled();
    expect(apiMock.createClient).toHaveBeenCalledTimes(1);
    expect(apiMock.__instance.post).toHaveBeenCalledTimes(2);
  });

  it('surfaces partial failures in the failed[] array and exits 1', async () => {
    apiMock.__instance.get.mockResolvedValue({ data: { statusCode: 100, body: DEVICE_LIST_BODY } });
    // BOT1 succeeds, BOT2 fails.
    apiMock.__instance.post
      .mockResolvedValueOnce({ data: { statusCode: 100, body: {} } })
      .mockRejectedValueOnce(new Error('timeout'));

    const result = await runCli(registerDevicesCommand, [
      '--json',
      'devices',
      'batch',
      'turnOn',
      '--ids',
      'BOT1,BOT2',
    ]);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout[0]);
    expect(parsed.summary.ok).toBe(1);
    expect(parsed.summary.failed).toBe(1);
    expect(parsed.failed[0].deviceId).toBe('BOT2');
    expect(parsed.failed[0].error.message).toMatch(/timeout/);
  });

  it('refuses destructive commands without --yes', async () => {
    apiMock.__instance.get.mockResolvedValue({ data: { statusCode: 100, body: DEVICE_LIST_BODY } });

    const result = await runCli(registerDevicesCommand, [
      'devices',
      'batch',
      'unlock',
      '--ids',
      'LOCK1',
    ]);

    expect(result.exitCode).toBe(2);
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
    expect(result.stderr.join('\n')).toMatch(/destructive/);
  });

  it('allows destructive commands when --yes is passed', async () => {
    apiMock.__instance.get.mockResolvedValue({ data: { statusCode: 100, body: DEVICE_LIST_BODY } });
    apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });

    const result = await runCli(registerDevicesCommand, [
      '--json',
      'devices',
      'batch',
      'unlock',
      '--ids',
      'LOCK1',
      '--yes',
    ]);

    expect(result.exitCode).toBeNull();
    expect(apiMock.__instance.post).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(result.stdout[0]);
    expect(parsed.summary.ok).toBe(1);
  });

  it('--dry-run does not send POSTs and marks all as skipped', async () => {
    flagsMock.dryRun = true;
    apiMock.__instance.get.mockResolvedValue({ data: { statusCode: 100, body: DEVICE_LIST_BODY } });
    // The real DryRunSignal would be raised by the axios interceptor at request
    // time; from the batch layer's perspective, our mocked `post` simulates
    // the throw.
    apiMock.__instance.post.mockImplementation(async () => {
      throw new apiMock.DryRunSignal('POST', '/v1.1/devices/BOT1/commands');
    });

    const result = await runCli(registerDevicesCommand, [
      '--json',
      'devices',
      'batch',
      'turnOn',
      '--ids',
      'BOT1,BOT2',
    ]);

    expect(result.exitCode).toBeNull();
    const parsed = JSON.parse(result.stdout[0]);
    expect(parsed.summary.ok).toBe(0);
    expect(parsed.summary.failed).toBe(0);
    expect(parsed.summary.skipped).toBe(2);
    expect(parsed.summary.dryRun).toBe(true);
  });

  it('prints a human summary line when not in JSON mode', async () => {
    apiMock.__instance.get.mockResolvedValue({ data: { statusCode: 100, body: DEVICE_LIST_BODY } });
    apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });

    const result = await runCli(registerDevicesCommand, [
      'devices',
      'batch',
      'turnOn',
      '--filter',
      'type=Bot',
    ]);

    expect(result.exitCode).toBeNull();
    const combined = result.stdout.join('\n');
    expect(combined).toMatch(/✓ BOT1/);
    expect(combined).toMatch(/✓ BOT2/);
    expect(combined).toMatch(/Summary: 2 ok, 0 failed/);
  });

  it('reports zero matches without calling POST', async () => {
    apiMock.__instance.get.mockResolvedValue({ data: { statusCode: 100, body: DEVICE_LIST_BODY } });
    const result = await runCli(registerDevicesCommand, [
      '--json',
      'devices',
      'batch',
      'turnOn',
      '--filter',
      'type=Unicorn',
    ]);
    expect(result.exitCode).toBeNull();
    const parsed = JSON.parse(result.stdout[0]);
    expect(parsed.summary.total).toBe(0);
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
  });
});
