import { describe, it, expect, beforeEach, vi } from 'vitest';

const apiMock = vi.hoisted(() => {
  const instance = { get: vi.fn(), post: vi.fn() };
  return {
    createClient: vi.fn(() => instance),
    __instance: instance,
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
  DryRunSignal: class DryRunSignal extends Error {
    constructor(public readonly method: string, public readonly url: string) {
      super('dry-run');
      this.name = 'DryRunSignal';
    }
  },
}));

const cacheMock = vi.hoisted(() => ({
  map: new Map<string, { type: string; name: string; category: 'physical' | 'ir' }>(),
  getCachedDevice: vi.fn((id: string) => cacheMock.map.get(id) ?? null),
  updateCacheFromDeviceList: vi.fn(),
  getCachedTypeMap: vi.fn(() => new Map<string, string>()),
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

const flagsMock = vi.hoisted(() => ({
  isDryRun: vi.fn(() => false),
  isVerbose: vi.fn(() => false),
  getTimeout: vi.fn(() => 30000),
  getConfigPath: vi.fn(() => undefined),
  getProfile: vi.fn(() => undefined),
  getAuditLog: vi.fn(() => null),
  getCacheMode: vi.fn(() => ({ listTtlMs: 0, statusTtlMs: 0 })),
  getFormat: vi.fn(() => undefined),
  getFields: vi.fn(() => undefined),
  parseDurationToMs: (v: string): number | null => {
    const m = /^(\d+)(ms|s|m|h)?$/.exec(v.trim().toLowerCase());
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    const unit = m[2] ?? 'ms';
    switch (unit) {
      case 'ms': return n;
      case 's': return n * 1000;
      case 'm': return n * 60 * 1000;
      case 'h': return n * 60 * 60 * 1000;
      default: return null;
    }
  },
}));
vi.mock('../../src/utils/flags.js', () => flagsMock);

import { registerDevicesCommand } from '../../src/commands/devices.js';
import { runCli } from '../helpers/cli.js';

describe('devices watch', () => {
  beforeEach(() => {
    apiMock.__instance.get.mockReset();
    apiMock.__instance.post.mockReset();
    apiMock.createClient.mockClear();
    cacheMock.map.clear();
    cacheMock.getCachedDevice.mockClear();
    // Make sleep near-instant so --max exits the loop quickly.
  });

  it('rejects intervals below the 1s minimum with exit 2', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'watch', 'BOT1', '--interval', '500ms', '--max', '1',
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toMatch(/Invalid --interval/);
  });

  it('rejects --max=0 with exit 2', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'watch', 'BOT1', '--interval', '5s', '--max', '0',
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toMatch(/Invalid --max/);
  });

  it('emits one JSONL event per device on first tick with from:null (--max=1)', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'Kitchen', category: 'physical' });
    apiMock.__instance.get.mockResolvedValueOnce({
      data: { statusCode: 100, body: { power: 'on', battery: 90 } },
    });

    const res = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'watch', 'BOT1', '--interval', '5s', '--max', '1',
    ]);

    // Loop exits via --max so parseAsync resolves — exitCode is null.
    expect(res.exitCode).toBeNull();
    const lines = res.stdout.filter((l) => l.trim().startsWith('{'));
    expect(lines.length).toBe(1);
    const ev = JSON.parse(lines[0]);
    expect(ev.deviceId).toBe('BOT1');
    expect(ev.type).toBe('Bot');
    expect(ev.tick).toBe(1);
    expect(ev.changed.power).toEqual({ from: null, to: 'on' });
    expect(ev.changed.battery).toEqual({ from: null, to: 90 });
    expect(apiMock.createClient).toHaveBeenCalledTimes(1);
  });

  it('only emits changed fields on subsequent ticks', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'Kitchen', category: 'physical' });
    apiMock.__instance.get
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { power: 'on', battery: 90 } } })
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { power: 'off', battery: 90 } } });

    const res = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'watch', 'BOT1', '--interval', '1s', '--max', '2',
    ]);
    expect(res.exitCode).toBeNull();

    const events = res.stdout
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l));
    expect(events).toHaveLength(2);
    expect(events[0].tick).toBe(1);
    // Tick 2 should only include the power change — battery stayed 90.
    expect(events[1].tick).toBe(2);
    expect(events[1].changed.power).toEqual({ from: 'on', to: 'off' });
    expect(events[1].changed.battery).toBeUndefined();
  }, 20_000);

  it('suppresses unchanged ticks unless --include-unchanged is passed', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'K', category: 'physical' });
    apiMock.__instance.get
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { power: 'on' } } })
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { power: 'on' } } });

    const res = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'watch', 'BOT1', '--interval', '1s', '--max', '2',
    ]);
    expect(res.exitCode).toBeNull();

    const events = res.stdout
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l));
    // Only tick 1 should have emitted (tick 2 had zero changes).
    expect(events).toHaveLength(1);
    expect(events[0].tick).toBe(1);
  }, 20_000);

  it('honors --include-unchanged', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'K', category: 'physical' });
    apiMock.__instance.get
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { power: 'on' } } })
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { power: 'on' } } });

    const res = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'watch', 'BOT1', '--interval', '1s', '--max', '2', '--include-unchanged',
    ]);
    expect(res.exitCode).toBeNull();

    const events = res.stdout
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l));
    expect(events).toHaveLength(2);
    expect(Object.keys(events[1].changed)).toHaveLength(0);
  }, 20_000);

  it('respects --fields (other fields are ignored in the diff)', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'K', category: 'physical' });
    apiMock.__instance.get
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { power: 'on', battery: 90, temp: 22 } } });
    flagsMock.getFields.mockReturnValueOnce(['power', 'battery']);

    const res = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'watch', 'BOT1', '--interval', '5s', '--max', '1', '--fields', 'power,battery',
    ]);
    expect(res.exitCode).toBeNull();

    const ev = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{'))[0]);
    expect(ev.changed.power).toBeDefined();
    expect(ev.changed.battery).toBeDefined();
    expect(ev.changed.temp).toBeUndefined();
  });

  it('continues polling other devices when one errors', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'K1', category: 'physical' });
    cacheMock.map.set('BOT2', { type: 'Bot', name: 'K2', category: 'physical' });
    // Parallel Promise.all, order of .get calls is not guaranteed — make both
    // calls deterministic by matching on URL.
    apiMock.__instance.get.mockImplementation(async (url: string) => {
      if (url.includes('BOT1')) throw new Error('boom');
      return { data: { statusCode: 100, body: { power: 'on' } } };
    });

    const res = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'watch', 'BOT1', 'BOT2', '--interval', '5s', '--max', '1',
    ]);
    expect(res.exitCode).toBeNull();

    const events = [
      ...res.stdout.filter((l) => l.trim().startsWith('{')),
      ...res.stderr.filter((l) => l.trim().startsWith('{')),
    ].map((l) => JSON.parse(l));
    expect(events).toHaveLength(2);
    const byId = Object.fromEntries(events.map((e) => [e.deviceId, e]));
    expect(byId.BOT1.error).toMatch(/boom/);
    expect(byId.BOT2.changed.power).toEqual({ from: null, to: 'on' });
  });
});
