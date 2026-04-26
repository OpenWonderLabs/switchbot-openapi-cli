import { describe, it, expect, beforeEach, vi } from 'vitest';
import { expectStreamHeaderShape } from '../helpers/contracts.js';

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
    expect(res.stderr.join('\n')).toMatch(/--max/);
  });

  it('--for stops the loop after elapsed time', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'Kitchen', category: 'physical' });
    apiMock.__instance.get.mockResolvedValue({
      data: { statusCode: 100, body: { power: 'on', battery: 90 } },
    });
    const res = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'watch', 'BOT1', '--interval', '1s', '--for', '200ms',
    ]);
    // --for triggers AbortController.abort() after 200ms; the loop exits
    // cleanly with exit code null (no unhandled throw).
    expect(res.exitCode).toBeNull();
  }, 3000);

  it('--initial=emit emits one JSONL event per device on first tick with from:null (--max=1)', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'Kitchen', category: 'physical' });
    apiMock.__instance.get.mockResolvedValueOnce({
      data: { statusCode: 100, body: { power: 'on', battery: 90 } },
    });

    const res = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'watch', 'BOT1', '--initial', 'emit', '--interval', '5s', '--max', '1',
    ]);

    // Loop exits via --max so parseAsync resolves — exitCode is null.
    expect(res.exitCode).toBeNull();
    const lines = res.stdout.filter((l) => l.trim().startsWith('{'));
    // P7: first line is the stream header; event is on the second line.
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).stream).toBe(true);
    const ev = JSON.parse(lines[1]).data;
    expect(ev.deviceId).toBe('BOT1');
    expect(ev.type).toBe('Bot');
    expect(ev.tick).toBe(1);
    expect(ev.changed.power).toEqual({ from: null, to: 'on' });
    expect(ev.changed.battery).toEqual({ from: null, to: 90 });
    expect(apiMock.createClient).toHaveBeenCalledTimes(1);
  });

  it('defaults to a snapshot baseline instead of null-to-value seed diffs', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'Kitchen', category: 'physical' });
    apiMock.__instance.get.mockResolvedValueOnce({
      data: { statusCode: 100, body: { power: 'on', battery: 90 } },
    });

    const res = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'watch', 'BOT1', '--interval', '5s', '--max', '1',
    ]);

    expect(res.exitCode).toBeNull();
    const lines = res.stdout.filter((l) => l.trim().startsWith('{'));
    expect(lines.length).toBe(2);
    const ev = JSON.parse(lines[1]).data;
    expect(ev.snapshot).toEqual({ power: 'on', battery: 90 });
    expect(ev.changed).toEqual({});
  });

  it('--initial=emit preserves the legacy null-to-value seed diff behavior', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'Kitchen', category: 'physical' });
    apiMock.__instance.get.mockResolvedValueOnce({
      data: { statusCode: 100, body: { power: 'on', battery: 90 } },
    });

    const res = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'watch', 'BOT1', '--initial', 'emit', '--interval', '5s', '--max', '1',
    ]);

    expect(res.exitCode).toBeNull();
    const lines = res.stdout.filter((l) => l.trim().startsWith('{'));
    const ev = JSON.parse(lines[1]).data;
    expect(ev.snapshot).toBeUndefined();
    expect(ev.changed.power).toEqual({ from: null, to: 'on' });
  });

  it('--initial=skip records the baseline silently and only emits later diffs', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'Kitchen', category: 'physical' });
    apiMock.__instance.get
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { power: 'on', battery: 90 } } })
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { power: 'off', battery: 90 } } });

    const res = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'watch', 'BOT1', '--initial', 'skip', '--interval', '1s', '--max', '2',
    ]);

    expect(res.exitCode).toBeNull();
    const events = res.stdout
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l))
      .filter((j) => !j.stream)
      .map((j) => j.data);
    expect(events).toHaveLength(1);
    expect(events[0].tick).toBe(2);
    expect(events[0].changed.power).toEqual({ from: 'on', to: 'off' });
  }, 20_000);

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
      .map((l) => JSON.parse(l))
      .filter((j) => !j.stream)
      .map((j) => j.data);
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
      .map((l) => JSON.parse(l))
      .filter((j) => !j.stream)
      .map((j) => j.data);
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
      .map((l) => JSON.parse(l))
      .filter((j) => !j.stream)
      .map((j) => j.data);
    expect(events).toHaveLength(2);
    expect(Object.keys(events[1].changed)).toHaveLength(0);
  }, 20_000);

  it('respects --fields (other fields are ignored in the diff)', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'K', category: 'physical' });
    apiMock.__instance.get
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { power: 'on', battery: 90, temp: 22 } } });
    flagsMock.getFields.mockReturnValueOnce(['power', 'battery']);

    const res = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'watch', 'BOT1', '--initial', 'emit', '--interval', '5s', '--max', '1', '--fields', 'power,battery',
    ]);
    expect(res.exitCode).toBeNull();

    const ev = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{') && !l.includes('"stream":true'))[0]).data;
    expect(ev.changed.power).toBeDefined();
    expect(ev.changed.battery).toBeDefined();
    expect(ev.changed.temp).toBeUndefined();
  });

  // P1 — FIELD_ALIASES dispatch for --fields
  it('P1: resolves --fields aliases against first API response (batt → battery)', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'K', category: 'physical' });
    apiMock.__instance.get
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { power: 'on', battery: 90, humidity: 40 } } });
    flagsMock.getFields.mockReturnValueOnce(['batt', 'humid']);

    const res = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'watch', 'BOT1', '--initial', 'emit', '--interval', '5s', '--max', '1', '--fields', 'batt,humid',
    ]);
    expect(res.exitCode).toBeNull();

    const ev = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{') && !l.includes('"stream":true'))[0]).data;
    // Only the aliased canonical fields should surface.
    expect(ev.changed.battery).toEqual({ from: null, to: 90 });
    expect(ev.changed.humidity).toEqual({ from: null, to: 40 });
    expect(ev.changed.power).toBeUndefined();
  });

  it('P1: exits 1 (handleError) when --fields names an unknown alias', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'K', category: 'physical' });
    apiMock.__instance.get
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { power: 'on', battery: 90 } } });
    flagsMock.getFields.mockReturnValueOnce(['zombie']);

    const res = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'watch', 'BOT1', '--interval', '5s', '--max', '1', '--fields', 'zombie',
    ]);
    // UsageError during watch is caught by handleError → exit 2.
    expect(res.exitCode).toBe(2);
    // With --json the envelope is routed to stdout (SYS-1 contract).
    const out = res.stdout.join('\n');
    expect(out).toMatch(/zombie/);
    const envelope = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).pop()!);
    expect(envelope.error.kind).toBe('usage');
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
    ]
      .map((l) => JSON.parse(l))
      .filter((j) => !j.stream)
      .map((j) => j.data);
    expect(events).toHaveLength(2);
    const byId = Object.fromEntries(events.map((e) => [e.deviceId, e]));
    expect(byId.BOT1.error).toMatch(/boom/);
    expect(byId.BOT2.snapshot).toEqual({ power: 'on' });
  });

  it('exits 2 when no deviceId and no --name', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'watch', '--max', '1',
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toMatch(/deviceId.*--name|--name.*deviceId/i);
  });

  it('exits 2 when --interval swallows a subcommand name (token-swallow regression)', async () => {
    const res = await runCli(registerDevicesCommand, [
      'devices', 'watch', 'BOT1', '--interval', 'devices',
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toMatch(/--interval.*(duration|look like)/i);
  });

  it('P7: emits a streaming JSON header line under --json before any tick', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'Kitchen', category: 'physical' });
    apiMock.__instance.get.mockResolvedValueOnce({
      data: { statusCode: 100, body: { power: 'on' } },
    });

    const res = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'watch', 'BOT1', '--interval', '5s', '--max', '1',
    ]);
    expect(res.exitCode).toBeNull();
    const lines = res.stdout.filter((l) => l.trim().startsWith('{'));
    // First line is the stream header; second is the event.
    expect(lines.length).toBe(2);
    const header = JSON.parse(lines[0]) as {
      schemaVersion: string;
      stream: boolean;
      eventKind: string;
      cadence: string;
    };
    expectStreamHeaderShape(header as Record<string, unknown>, 'tick', 'poll');
  });

  it('P7: watch JSONL tick records keep a stable envelope and event shape', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'Kitchen', category: 'physical' });
    apiMock.__instance.get.mockResolvedValueOnce({
      data: { statusCode: 100, body: { power: 'on', battery: 90 } },
    });

    const res = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'watch', 'BOT1', '--interval', '5s', '--max', '1',
    ]);

    const lines = res.stdout.filter((l) => l.trim().startsWith('{'));
    const event = JSON.parse(lines[1]) as { schemaVersion: string; data: Record<string, unknown> };
    expect(event.schemaVersion).toBe('1.1');
    expect(Object.keys(event)).toEqual(['schemaVersion', 'data']);
    expect(Object.keys(event.data)).toEqual(['t', 'tick', 'deviceId', 'type', 'changed', 'snapshot']);
  });

  it('P7: does NOT emit the stream header in non-JSON mode', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'Kitchen', category: 'physical' });
    apiMock.__instance.get.mockResolvedValueOnce({
      data: { statusCode: 100, body: { power: 'on' } },
    });

    const res = await runCli(registerDevicesCommand, [
      'devices', 'watch', 'BOT1', '--interval', '5s', '--max', '1',
    ]);
    expect(res.exitCode).toBeNull();
    // No JSON lines should be present on stdout in human mode.
    const jsonLines = res.stdout.filter((l) => l.trim().startsWith('{'));
    expect(jsonLines.length).toBe(0);
  });

  it('--help clarifies default format and calls out --json as agent-friendly', async () => {
    const res = await runCli(registerDevicesCommand, ['devices', 'watch', '--help']);
    const out = [...res.stdout, ...res.stderr].join('\n');
    // Help clarifies default (human table) and the agent form (JSONL with --json).
    expect(out).toMatch(/human-readable table/);
    expect(out).toMatch(/--json/);
    expect(out).toMatch(/JSON-Lines/);
    // Initial-poll modes are documented in help.
    expect(out).toMatch(/--initial=snapshot/i);
    expect(out).toMatch(/--initial=emit/i);
    expect(out).toMatch(/--initial=skip/i);
    // Example block explicitly labels the --json form as agent-friendly.
    expect(out).toMatch(/agent-friendly/i);
  });
});
