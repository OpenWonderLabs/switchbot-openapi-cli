import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Mock the API layer so we don't hit real HTTPS.
// ---------------------------------------------------------------------------
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
    public readonly retryable: boolean;
    public readonly hint?: string;
    public readonly retryAfterMs?: number;
    public readonly transient: boolean;
    constructor(
      message: string,
      public readonly code: number,
      meta: { retryable?: boolean; hint?: string; retryAfterMs?: number; transient?: boolean } = {}
    ) {
      super(message);
      this.name = 'ApiError';
      this.retryable = meta.retryable ?? false;
      this.hint = meta.hint;
      this.retryAfterMs = meta.retryAfterMs;
      this.transient = meta.transient ?? false;
    }
  },
  DryRunSignal: class DryRunSignal extends Error {
    constructor(public readonly method: string, public readonly url: string) {
      super('dry-run');
      this.name = 'DryRunSignal';
    }
  },
}));

// Mock the cache so MCP's send_command validation/destructive-check paths are
// deterministic and don't depend on the user's ~/.switchbot/devices.json.
const cacheMock = vi.hoisted(() => {
  return {
    map: new Map<string, { type: string; name: string; category: 'physical' | 'ir' }>(),
    getCachedDevice: vi.fn((id: string) => cacheMock.map.get(id) ?? null),
    updateCacheFromDeviceList: vi.fn(),
  };
});

vi.mock('../../src/devices/cache.js', () => ({
  getCachedDevice: cacheMock.getCachedDevice,
  updateCacheFromDeviceList: cacheMock.updateCacheFromDeviceList,
  loadCache: vi.fn(() => null),
  clearCache: vi.fn(),
  isListCacheFresh: vi.fn(() => false),
  listCacheAgeMs: vi.fn(() => null),
  getCachedStatus: vi.fn(() => null),
  setCachedStatus: vi.fn(),
  clearStatusCache: vi.fn(),
  loadStatusCache: vi.fn(() => ({ entries: {} })),
  describeCache: vi.fn(() => ({
    list: { path: '', exists: false },
    status: { path: '', exists: false, entryCount: 0 },
  })),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSwitchBotMcpServer } from '../../src/commands/mcp.js';
import { registerPolicyCommand } from '../../src/commands/policy.js';
import { ApiError } from '../../src/api/client.js';

/** Connect a fresh server + client pair and return both. */
async function pair() {
  const server = createSwitchBotMcpServer();
  const client = new Client({ name: 'test', version: '0.0.1' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { server, client };
}

class ExitError extends Error {
  constructor(public code: number) {
    super(`__exit:${code}__`);
  }
}

function runPolicyDiffCliJson(leftPath: string, rightPath: string): Record<string, unknown> {
  const stdout: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);

  const program = new Command();
  program.option('--json');
  registerPolicyCommand(program);
  const prevArgv = process.argv;

  let exitCode = 0;
  try {
    process.argv = ['node', 'switchbot', '--json', 'policy', 'diff', leftPath, rightPath];
    program.parse(['node', 'switchbot', '--json', 'policy', 'diff', leftPath, rightPath]);
  } catch (err) {
    if (err instanceof ExitError) exitCode = err.code;
    else throw err;
  } finally {
    process.argv = prevArgv;
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }

  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout[0]) as { data: Record<string, unknown> };
  return parsed.data;
}

describe('mcp server', () => {
  beforeEach(() => {
    apiMock.__instance.get.mockReset();
    apiMock.__instance.post.mockReset();
    cacheMock.map.clear();
    cacheMock.getCachedDevice.mockClear();
    cacheMock.updateCacheFromDeviceList.mockClear();
  });

  it('exposes the twenty-one tools with titles and input schemas', async () => {
    const { client } = await pair();
    const { tools } = await client.listTools();

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'account_overview',
        'aggregate_device_history',
        'audit_query',
        'audit_stats',
        'describe_device',
        'get_device_history',
        'get_device_status',
        'list_devices',
        'list_scenes',
        'plan_run',
        'plan_suggest',
        'policy_add_rule',
        'policy_diff',
        'policy_migrate',
        'policy_new',
        'policy_validate',
        'query_device_history',
        'rules_suggest',
        'run_scene',
        'search_catalog',
        'send_command',
      ].sort()
    );

    for (const t of tools) {
      expect(t.description, `${t.name} should have a description`).toBeTypeOf('string');
      expect(t.inputSchema, `${t.name} should expose an inputSchema`).toBeDefined();
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('send_command rejects destructive commands without confirm:true', async () => {
    cacheMock.map.set('LOCK1', { type: 'Smart Lock', name: 'Front Door', category: 'physical' });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'LOCK1', command: 'unlock' },
    });

    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.error.kind).toBe('guard');
    expect(parsed.error.code).toBe(3);
    expect(parsed.error.context.command).toBe('unlock');
    expect(parsed.error.context.deviceType).toBe('Smart Lock');
    // destructiveReason should be present so agents can explain it to users
    expect(parsed.error.context.destructiveReason).toBeTypeOf('string');
    expect(parsed.error.hint).toContain('Reason:');
    // Should not have called the API at all.
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
  });

  it('send_command allows destructive commands when confirm:true', async () => {
    cacheMock.map.set('LOCK1', { type: 'Smart Lock', name: 'Front Door', category: 'physical' });
    apiMock.__instance.post.mockResolvedValueOnce({
      data: { statusCode: 100, body: { commandId: 'xyz' } },
    });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'LOCK1', command: 'unlock', confirm: true },
    });

    expect(res.isError).toBeFalsy();
    expect(apiMock.__instance.post).toHaveBeenCalledTimes(1);
    const [url, body] = apiMock.__instance.post.mock.calls[0];
    expect(url).toBe('/v1.1/devices/LOCK1/commands');
    expect(body).toMatchObject({ command: 'unlock', commandType: 'command' });
  });

  it('send_command rejects an unknown command name before calling the API', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'Kitchen Bot', category: 'physical' });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'BOT1', command: 'explode' },
    });

    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.error.kind).toBe('usage');
    expect(parsed.error.code).toBe(2);
    expect(parsed.error.context.validationKind).toBe('unknown-command');
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
  });

  it('send_command rejects read-only device commands before calling the API', async () => {
    cacheMock.map.set('METER1', { type: 'Meter', name: 'Bedroom Meter', category: 'physical' });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'METER1', command: 'turnOn' },
    });

    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.error.kind).toBe('usage');
    expect(parsed.error.context.validationKind).toBe('read-only-device');
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
  });

  it('send_command sends non-destructive commands through without confirm', async () => {
    cacheMock.map.set('BULB1', { type: 'Color Bulb', name: 'Desk Lamp', category: 'physical' });
    apiMock.__instance.post.mockResolvedValueOnce({
      data: { statusCode: 100, body: {} },
    });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'BULB1', command: 'turnOn' },
    });

    expect(res.isError).toBeFalsy();
    expect(apiMock.__instance.post).toHaveBeenCalledTimes(1);
  });

  it('send_command dryRun rejects unknown deviceId against local cache (bug #SYS-3)', async () => {
    // Cache is empty — no devices known.
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'DEADBEEF', command: 'turnOff', dryRun: true },
    });

    expect(res.isError).toBe(true);
    const structured = res.structuredContent as { error?: { kind?: string; subKind?: string; context?: { deviceId?: string } } };
    expect(structured.error?.kind).toBe('usage');
    expect(structured.error?.subKind).toBe('device-not-found');
    expect(structured.error?.context?.deviceId).toBe('DEADBEEF');
    // Dry-run must not hit the network even for preflight.
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
    expect(apiMock.__instance.get).not.toHaveBeenCalled();
  });

  it('send_command dryRun succeeds when deviceId is cached (bug #SYS-3 happy path)', async () => {
    cacheMock.map.set('BULB1', { type: 'Color Bulb', name: 'Desk Lamp', category: 'physical' });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'BULB1', command: 'turnOff', dryRun: true },
    });

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as { ok?: boolean; dryRun?: boolean; wouldSend?: { deviceId?: string; command?: string } };
    expect(structured.ok).toBe(true);
    expect(structured.dryRun).toBe(true);
    expect(structured.wouldSend?.deviceId).toBe('BULB1');
    expect(structured.wouldSend?.command).toBe('turnOff');
  });

  it('send_command rejects out-of-range setBrightness in dry-run (R-2, 2.6.1)', async () => {
    cacheMock.map.set('BULB1', { type: 'Color Bulb', name: 'Desk Lamp', category: 'physical' });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'BULB1', command: 'setBrightness', parameter: '101', dryRun: true },
    });

    expect(res.isError).toBe(true);
    const structured = res.structuredContent as { error?: { kind?: string; message?: string } };
    expect(structured.error?.kind).toBe('usage');
    expect(structured.error?.message).toMatch(/setBrightness.*1-100/);
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
  });

  it('send_command rejects out-of-range setBrightness live-path (R-2, 2.6.1)', async () => {
    cacheMock.map.set('BULB1', { type: 'Color Bulb', name: 'Desk Lamp', category: 'physical' });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'BULB1', command: 'setBrightness', parameter: '0' },
    });

    expect(res.isError).toBe(true);
    const structured = res.structuredContent as { error?: { kind?: string; message?: string } };
    expect(structured.error?.kind).toBe('usage');
    expect(structured.error?.message).toMatch(/setBrightness.*1-100/);
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
  });

  it('send_command normalizes setColor hex to R:G:B before dispatch (R-2, 2.6.1)', async () => {
    cacheMock.map.set('BULB1', { type: 'Color Bulb', name: 'Desk Lamp', category: 'physical' });
    apiMock.__instance.post.mockResolvedValueOnce({
      data: { statusCode: 100, body: {} },
    });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'BULB1', command: 'setColor', parameter: '#FF0000' },
    });

    expect(res.isError).toBeFalsy();
    expect(apiMock.__instance.post).toHaveBeenCalledTimes(1);
    const [, body] = apiMock.__instance.post.mock.calls[0];
    expect(body).toMatchObject({ command: 'setColor', parameter: '255:0:0' });
  });

  it('send_command dry-run surfaces normalized setColor parameter (R-2, 2.6.1)', async () => {
    cacheMock.map.set('BULB1', { type: 'Color Bulb', name: 'Desk Lamp', category: 'physical' });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'BULB1', command: 'setColor', parameter: 'red', dryRun: true },
    });

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as { wouldSend?: { parameter?: string } };
    expect(structured.wouldSend?.parameter).toBe('255:0:0');
  });

  it('send_command normalizes command casing (e.g. turnon → turnOn)', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'My Bot', category: 'physical' });
    apiMock.__instance.post.mockResolvedValueOnce({
      data: { statusCode: 100, body: {} },
    });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'BOT1', command: 'turnon' },
    });

    expect(res.isError).toBeFalsy();
    const [, body] = apiMock.__instance.post.mock.calls[0];
    expect(body).toMatchObject({ command: 'turnOn' });
  });

  it('list_devices returns the raw API body and refreshes the cache', async () => {
    const body = { deviceList: [], infraredRemoteList: [] };
    apiMock.__instance.get.mockResolvedValueOnce({ data: { statusCode: 100, body } });
    const { client } = await pair();

    const res = await client.callTool({ name: 'list_devices', arguments: {} });
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed).toEqual(body);
    expect(cacheMock.updateCacheFromDeviceList).toHaveBeenCalled();
  });

  it('describe_device returns capabilities with safetyTier surfaced', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({
      data: {
        statusCode: 100,
        body: {
          deviceList: [
            {
              deviceId: 'LOCK1',
              deviceName: 'Front',
              deviceType: 'Smart Lock',
              enableCloudService: true,
              hubDeviceId: 'HUB1',
            },
          ],
          infraredRemoteList: [],
        },
      },
    });
    const { client } = await pair();

    const res = await client.callTool({ name: 'describe_device', arguments: { deviceId: 'LOCK1' } });
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.typeName).toBe('Smart Lock');
    expect(parsed.capabilities.role).toBe('security');
    const unlock = parsed.capabilities.commands.find((c: { command: string }) => c.command === 'unlock');
    expect(unlock.safetyTier).toBe('destructive');
  });

  it('describe_device returns isError for a missing deviceId', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({
      data: { statusCode: 100, body: { deviceList: [], infraredRemoteList: [] } },
    });
    const { client } = await pair();

    const res = await client.callTool({ name: 'describe_device', arguments: { deviceId: 'NOPE' } });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/No device with id/);
  });

  it('describe_device with live:true merges /status payload', async () => {
    apiMock.__instance.get
      .mockResolvedValueOnce({
        data: {
          statusCode: 100,
          body: {
            deviceList: [
              {
                deviceId: 'BULB1',
                deviceName: 'Desk',
                deviceType: 'Color Bulb',
                enableCloudService: true,
                hubDeviceId: 'HUB1',
              },
            ],
            infraredRemoteList: [],
          },
        },
      })
      .mockResolvedValueOnce({
        data: { statusCode: 100, body: { power: 'on', brightness: 80 } },
      });

    const { client } = await pair();
    const res = await client.callTool({ name: 'describe_device', arguments: { deviceId: 'BULB1', live: true } });
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.source).toBe('catalog+live');
    expect(parsed.capabilities.liveStatus).toEqual({ power: 'on', brightness: 80 });
  });

  it('search_catalog returns entries matching by alias', async () => {
    const { client } = await pair();
    const res = await client.callTool({
      name: 'search_catalog',
      arguments: { query: 'Strip Light 3' },
    });
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((e: { type: string }) => e.type === 'Strip Light')).toBe(true);
  });

  it('search_catalog rejects an empty query with a usage error', async () => {
    const { client } = await pair();
    const res = await client.callTool({
      name: 'search_catalog',
      arguments: { query: '' },
    });
    expect(res.isError).toBe(true);
    const structured = (res as { structuredContent?: { error?: { kind?: string; message?: string; hint?: string } } }).structuredContent;
    expect(structured?.error?.kind).toBe('usage');
    expect(structured?.error?.message).toMatch(/non-empty query/i);
    expect(structured?.error?.hint).toMatch(/list_catalog_types/);
  });

  it('search_catalog rejects whitespace-only query', async () => {
    const { client } = await pair();
    const res = await client.callTool({
      name: 'search_catalog',
      arguments: { query: '   ' },
    });
    expect(res.isError).toBe(true);
  });

  it('run_scene POSTs the scene execute endpoint', async () => {
    apiMock.__instance.post.mockResolvedValueOnce({ data: { statusCode: 100, body: {} } });
    const { client } = await pair();

    const res = await client.callTool({ name: 'run_scene', arguments: { sceneId: 'S123' } });
    expect(res.isError).toBeFalsy();
    expect(apiMock.__instance.post).toHaveBeenCalledWith('/v1.1/scenes/S123/execute');
  });

  it('get_device_status forwards the status body', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({
      data: { statusCode: 100, body: { battery: 82, power: 'on' } },
    });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'get_device_status',
      arguments: { deviceId: 'BOT1' },
    });
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed).toEqual({ battery: 82, power: 'on' });
  });

  it('send_command falls back to a fresh device-list lookup when cache is cold', async () => {
    // No cache entry for COLDBOT yet.
    apiMock.__instance.get.mockResolvedValueOnce({
      data: {
        statusCode: 100,
        body: {
          deviceList: [
            {
              deviceId: 'COLDBOT',
              deviceName: 'Bot',
              deviceType: 'Bot',
              enableCloudService: true,
              hubDeviceId: 'HUB1',
            },
          ],
          infraredRemoteList: [],
        },
      },
    });
    apiMock.__instance.post.mockResolvedValueOnce({ data: { statusCode: 100, body: {} } });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'COLDBOT', command: 'turnOn' },
    });
    expect(res.isError).toBeFalsy();
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/devices');
    expect(apiMock.__instance.post).toHaveBeenCalledWith(
      '/v1.1/devices/COLDBOT/commands',
      expect.objectContaining({ command: 'turnOn' })
    );
  });

  it('lists aggregate_device_history with _meta.agentSafetyTier=read', async () => {
    const { client } = await pair();
    const { tools } = await client.listTools();

    const tool = tools.find((t) => t.name === 'aggregate_device_history');
    expect(tool, 'aggregate_device_history should be listed').toBeDefined();
    expect((tool as { _meta?: { agentSafetyTier?: string } } | undefined)?._meta?.agentSafetyTier).toBe('read');
  });

  it('aggregate_device_history rejects unknown input keys with -32602', async () => {
    const { client } = await pair();

    const res = await client.callTool({
      name: 'aggregate_device_history',
      arguments: { deviceId: 'DEV1', metrics: ['temperature'], bogusField: 'nope' },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toMatch(/-32602|unrecognized_keys|Unrecognized key/i);
  });

  it('aggregate_device_history returns the same shape as the CLI --json.data', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-agg-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);

    try {
      const histDir = path.join(tmpHome, '.switchbot', 'device-history');
      fs.mkdirSync(histDir, { recursive: true });
      const lines = [
        JSON.stringify({ t: '2026-04-19T10:00:00.000Z', topic: 't/DEV1', payload: { temperature: 20 } }),
        JSON.stringify({ t: '2026-04-19T10:30:00.000Z', topic: 't/DEV1', payload: { temperature: 24 } }),
      ];
      fs.writeFileSync(path.join(histDir, 'DEV1.jsonl'), lines.join('\n') + '\n');

      const { client } = await pair();
      const res = await client.callTool({
        name: 'aggregate_device_history',
        arguments: {
          deviceId: 'DEV1',
          from: '2026-04-19T00:00:00.000Z',
          to: '2026-04-20T00:00:00.000Z',
          metrics: ['temperature'],
          aggs: ['count', 'avg'],
        },
      });

      expect(res.isError).toBeFalsy();
      const sc = (res as { structuredContent?: unknown }).structuredContent as Record<string, unknown> | undefined;
      const buckets = (
        sc && 'buckets' in sc
          ? (sc as { buckets: unknown[] }).buckets
          : (sc as { data?: { buckets: unknown[] } } | undefined)?.data?.buckets
      ) as Array<{ metrics: { temperature: { count?: number; avg?: number } } }> | undefined;

      expect(buckets, 'structuredContent should have buckets').toBeDefined();
      expect(buckets![0].metrics.temperature.count).toBe(2);
      expect(buckets![0].metrics.temperature.avg).toBe(22);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Bug #38: structured error metadata preserved in MCP tool responses
  // ---------------------------------------------------------------------------

  it('send_command preserves structured error metadata on ApiError (code 161 device-offline)', async () => {
    cacheMock.map.set('BLE1', { type: 'Bot', name: 'BLE Bot', category: 'physical' });
    // Mock the POST to throw a device-offline ApiError
    apiMock.__instance.post.mockRejectedValueOnce(
      new ApiError('Device offline (check Wi-Fi / Bluetooth connection)', 161, { transient: false })
    );
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'BLE1', command: 'turnOn' },
    });

    expect(res.isError).toBe(true);
    const sc = (res as { structuredContent?: unknown }).structuredContent as
      | { error?: { code?: number; subKind?: string; transient?: boolean; hint?: string } }
      | undefined;
    expect(sc?.error?.code).toBe(161);
    expect(sc?.error?.subKind).toBe('device-offline');
    expect(sc?.error?.transient).toBe(false);
    expect(sc?.error?.hint).toMatch(/Hub/);
    // content[0].text must still be a JSON string (backwards compat)
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('describe_device preserves structured error metadata on ApiError (code 401 auth-failed)', async () => {
    // Mock the GET (fetchDeviceList inside describeDevice) to throw auth error
    apiMock.__instance.get.mockRejectedValueOnce(
      new ApiError('Authentication failed', 401, { transient: false, retryable: false })
    );
    const { client } = await pair();

    const res = await client.callTool({
      name: 'describe_device',
      arguments: { deviceId: 'ANY1' },
    });

    expect(res.isError).toBe(true);
    const sc = (res as { structuredContent?: unknown }).structuredContent as
      | { error?: { subKind?: string; errorClass?: string } }
      | undefined;
    expect(sc?.error?.subKind).toBe('auth-failed');
    expect(sc?.error?.errorClass).toBe('api');
  });

  it('run_scene preserves structured error metadata on ApiError (code 190 device-internal-error)', async () => {
    // Mock the POST (executeScene) to throw device-internal-error ApiError
    apiMock.__instance.post.mockRejectedValueOnce(
      new ApiError('Device internal error', 190, { transient: false })
    );
    const { client } = await pair();

    const res = await client.callTool({
      name: 'run_scene',
      arguments: { sceneId: 'SCENE1' },
    });

    expect(res.isError).toBe(true);
    const sc = (res as { structuredContent?: unknown }).structuredContent as
      | { error?: { subKind?: string } }
      | undefined;
    expect(sc?.error?.subKind).toBe('device-internal-error');
  });

  describe('plan/audit tools', () => {
    it('plan_run skips destructive steps when yes is not set', async () => {
      cacheMock.map.set('LOCK1', { type: 'Smart Lock', name: 'Front Door', category: 'physical' });
      const { client } = await pair();

      const res = await client.callTool({
        name: 'plan_run',
        arguments: {
          plan: {
            version: '1.0',
            steps: [{ type: 'command', deviceId: 'LOCK1', command: 'unlock' }],
          },
        },
      });

      expect(res.isError).toBeFalsy();
      const sc = (res as { structuredContent?: Record<string, unknown> }).structuredContent!;
      const summary = sc.summary as Record<string, number>;
      expect(summary.total).toBe(1);
      expect(summary.skipped).toBe(1);
      expect(summary.error).toBe(0);
    });

    it('audit_query filters entries by result', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-audit-'));
      const auditPath = path.join(tmp, 'audit.log');
      const lines = [
        JSON.stringify({
          auditVersion: 2,
          t: '2026-04-24T00:00:00.000Z',
          kind: 'command',
          deviceId: 'BOT1',
          command: 'turnOn',
          parameter: 'default',
          commandType: 'command',
          dryRun: false,
          result: 'ok',
        }),
        JSON.stringify({
          auditVersion: 2,
          t: '2026-04-24T00:05:00.000Z',
          kind: 'rule-fire',
          deviceId: 'BOT1',
          command: 'turnOff',
          parameter: 'default',
          commandType: 'command',
          dryRun: false,
          result: 'error',
          error: 'boom',
          rule: { name: 'night-off', triggerSource: 'cron', fireId: 'f1' },
        }),
      ];
      fs.writeFileSync(auditPath, lines.join('\n') + '\n', 'utf-8');

      const { client } = await pair();
      const res = await client.callTool({
        name: 'audit_query',
        arguments: { file: auditPath, results: ['error'] },
      });

      expect(res.isError).toBeFalsy();
      const sc = (res as { structuredContent?: Record<string, unknown> }).structuredContent!;
      expect(sc.totalMatched).toBe(1);
      expect(sc.returned).toBe(1);
      const entries = sc.entries as Array<{ kind: string; result?: string }>;
      expect(entries[0].kind).toBe('rule-fire');
      expect(entries[0].result).toBe('error');

      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('audit_stats aggregates by kind/result/device/rule', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-audit-'));
      const auditPath = path.join(tmp, 'audit.log');
      const lines = [
        JSON.stringify({
          auditVersion: 2,
          t: '2026-04-24T01:00:00.000Z',
          kind: 'command',
          deviceId: 'BOT1',
          command: 'turnOn',
          parameter: 'default',
          commandType: 'command',
          dryRun: false,
          result: 'ok',
        }),
        JSON.stringify({
          auditVersion: 2,
          t: '2026-04-24T01:01:00.000Z',
          kind: 'rule-fire',
          deviceId: 'BOT1',
          command: 'turnOff',
          parameter: 'default',
          commandType: 'command',
          dryRun: false,
          result: 'ok',
          rule: { name: 'night-off', triggerSource: 'cron', fireId: 'f2' },
        }),
      ];
      fs.writeFileSync(auditPath, lines.join('\n') + '\n', 'utf-8');

      const { client } = await pair();
      const res = await client.callTool({
        name: 'audit_stats',
        arguments: { file: auditPath },
      });

      expect(res.isError).toBeFalsy();
      const sc = (res as { structuredContent?: Record<string, unknown> }).structuredContent!;
      expect(sc.totalMatched).toBe(2);
      const byKind = sc.byKind as Record<string, number>;
      expect(byKind.command).toBe(1);
      expect(byKind['rule-fire']).toBe(1);
      const topDevices = sc.topDevices as Array<{ deviceId: string; count: number }>;
      expect(topDevices[0]).toMatchObject({ deviceId: 'BOT1', count: 2 });
      const topRules = sc.topRules as Array<{ ruleName: string; count: number }>;
      expect(topRules[0]).toMatchObject({ ruleName: 'night-off', count: 1 });

      fs.rmSync(tmp, { recursive: true, force: true });
    });
  });

  // ---- policy_validate / policy_new / policy_migrate / policy_diff ---------
  describe('policy tools', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmcp-policy-'));
    });

    it('policy_validate returns present:false when the file does not exist', async () => {
      const { client } = await pair();
      const missing = path.join(tmp, 'nope.yaml');
      const res = await client.callTool({
        name: 'policy_validate',
        arguments: { path: missing },
      });
      expect(res.isError).toBeFalsy();
      const sc = (res as { structuredContent?: Record<string, unknown> }).structuredContent!;
      expect(sc.present).toBe(false);
      expect(sc.valid).toBeNull();
      expect(sc.policyPath).toBe(missing);
    });

    it('policy_validate returns valid:false with unsupported-version on a v0.1 file (v3.0)', async () => {
      const policyPath = path.join(tmp, 'policy.yaml');
      fs.writeFileSync(policyPath, 'version: "0.1"\n');
      const { client } = await pair();
      const res = await client.callTool({
        name: 'policy_validate',
        arguments: { path: policyPath },
      });
      expect(res.isError).toBeFalsy();
      const sc = (res as { structuredContent?: Record<string, unknown> }).structuredContent!;
      expect(sc.present).toBe(true);
      expect(sc.valid).toBe(false);
      const errors = sc.errors as Array<{ keyword: string }>;
      expect(Array.isArray(errors)).toBe(true);
      expect(errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
    });

    it('policy_validate returns valid:false + errors when schema rejects', async () => {
      const policyPath = path.join(tmp, 'bad.yaml');
      fs.writeFileSync(
        policyPath,
        'version: "0.1"\naliases:\n  "bedroom ac": "02-abc-lowercase"\n',
      );
      const { client } = await pair();
      const res = await client.callTool({
        name: 'policy_validate',
        arguments: { path: policyPath },
      });
      const sc = (res as { structuredContent?: Record<string, unknown> }).structuredContent!;
      expect(sc.present).toBe(true);
      expect(sc.valid).toBe(false);
      expect((sc.errors as unknown[]).length).toBeGreaterThan(0);
    });

    it('policy_new writes a starter file and refuses to overwrite without force', async () => {
      const policyPath = path.join(tmp, 'policy.yaml');
      const { client } = await pair();
      const first = await client.callTool({
        name: 'policy_new',
        arguments: { path: policyPath },
      });
      expect(first.isError).toBeFalsy();
      expect(fs.existsSync(policyPath)).toBe(true);
      const firstSc = (first as { structuredContent?: Record<string, unknown> }).structuredContent!;
      expect(firstSc.overwritten).toBe(false);
      expect((firstSc.bytesWritten as number) > 0).toBe(true);

      // Second call without force must error-guard.
      const second = await client.callTool({
        name: 'policy_new',
        arguments: { path: policyPath },
      });
      expect(second.isError).toBe(true);
      const text = (second.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/refusing to overwrite/i);

      // With force:true it succeeds.
      const third = await client.callTool({
        name: 'policy_new',
        arguments: { path: policyPath, force: true },
      });
      expect(third.isError).toBeFalsy();
      const thirdSc = (third as { structuredContent?: Record<string, unknown> }).structuredContent!;
      expect(thirdSc.overwritten).toBe(true);
    });

    it('policy_migrate reports already-current on a v0.2 file', async () => {
      const policyPath = path.join(tmp, 'policy.yaml');
      fs.writeFileSync(policyPath, 'version: "0.2"\n');
      const { client } = await pair();
      const res = await client.callTool({
        name: 'policy_migrate',
        arguments: { path: policyPath },
      });
      expect(res.isError).toBeFalsy();
      const sc = (res as { structuredContent?: Record<string, unknown> }).structuredContent!;
      expect(sc.status).toBe('already-current');
      expect(sc.fileVersion).toBe('0.2');
      expect(sc.targetVersion).toBe('0.2');
    });

    it('policy_migrate returns status:unsupported for v0.1 (no migration path in v3.0)', async () => {
      const policyPath = path.join(tmp, 'policy.yaml');
      const original = [
        '# my policy',
        'version: "0.1"',
        '',
        'aliases:',
        '  "lamp": "01-202407090924-26354212"',
        '',
      ].join('\n');
      fs.writeFileSync(policyPath, original);
      const { client } = await pair();
      const res = await client.callTool({
        name: 'policy_migrate',
        arguments: { path: policyPath },
      });
      expect(res.isError).toBeFalsy();
      const sc = (res as { structuredContent?: Record<string, unknown> }).structuredContent!;
      // v0.1 is not in SUPPORTED_POLICY_SCHEMA_VERSIONS — returns 'unsupported'.
      expect(sc.status).toBe('unsupported');
      // File must be untouched.
      expect(fs.readFileSync(policyPath, 'utf-8')).toBe(original);
    });

    it('policy_migrate dryRun on v0.1 returns status:unsupported (no path in v3.0)', async () => {
      const policyPath = path.join(tmp, 'policy.yaml');
      fs.writeFileSync(policyPath, 'version: "0.1"\n');
      const before = fs.readFileSync(policyPath, 'utf-8');
      const { client } = await pair();
      const res = await client.callTool({
        name: 'policy_migrate',
        arguments: { path: policyPath, dryRun: true },
      });
      const sc = (res as { structuredContent?: Record<string, unknown> }).structuredContent!;
      // v0.1 is unsupported — returns 'unsupported' before reaching dry-run logic.
      expect(sc.status).toBe('unsupported');
      expect(fs.readFileSync(policyPath, 'utf-8')).toBe(before);
    });

    it('policy_migrate refuses to write when the upgraded file would fail validation (v0.2 source)', async () => {
      // Test the precheck-failed path using a v0.2 file that planMigration
      // will validate as already-current but with a bad rule shape.
      // Since MIGRATION_CHAIN is now empty, we test precheck-failed via a
      // a v0.2 file with a malformed rule that fails the v0.2 schema.
      // Note: a v0.1 file now returns 'unsupported' (not 'precheck-failed').
      const policyPath = path.join(tmp, 'policy.yaml');
      fs.writeFileSync(
        policyPath,
        ['version: "0.1"', 'automation:', '  rules:', '    - foo: bar', ''].join('\n'),
      );
      const before = fs.readFileSync(policyPath, 'utf-8');
      const { client } = await pair();
      const res = await client.callTool({
        name: 'policy_migrate',
        arguments: { path: policyPath },
      });
      const sc = (res as { structuredContent?: Record<string, unknown> }).structuredContent!;
      // v0.1 is unsupported — returns 'unsupported' before reaching precheck.
      expect(sc.status).toBe('unsupported');
      // File must stay untouched.
      expect(fs.readFileSync(policyPath, 'utf-8')).toBe(before);
    });

    it('policy_migrate reports file-not-found when the file does not exist', async () => {
      const missing = path.join(tmp, 'missing.yaml');
      const { client } = await pair();
      const res = await client.callTool({
        name: 'policy_migrate',
        arguments: { path: missing },
      });
      const sc = (res as { structuredContent?: Record<string, unknown> }).structuredContent!;
      expect(sc.status).toBe('file-not-found');
    });

    it('policy_diff returns the same output contract as CLI policy diff --json', async () => {
      const leftPath = path.join(tmp, 'left.yaml');
      const rightPath = path.join(tmp, 'right.yaml');
      fs.writeFileSync(leftPath, ['version: "0.1"', 'quiet_hours:', '  start: "22:00"', ''].join('\n'));
      fs.writeFileSync(rightPath, ['version: "0.2"', 'quiet_hours:', '  start: "23:00"', ''].join('\n'));
      const { client } = await pair();
      const res = await client.callTool({
        name: 'policy_diff',
        arguments: { left_path: leftPath, right_path: rightPath },
      });
      expect(res.isError).toBeFalsy();
      const sc = (res as { structuredContent?: Record<string, unknown> }).structuredContent!;
      expect(sc.leftPath).toBe(leftPath);
      expect(sc.rightPath).toBe(rightPath);
      expect(sc.equal).toBe(false);
      expect((sc.changeCount as number) > 0).toBe(true);
      const stats = sc.stats as Record<string, number>;
      expect(stats.changed > 0).toBe(true);
      const changes = sc.changes as Array<{ path: string; kind: string }>;
      expect(changes.some((c) => c.path === '$.version' && c.kind === 'changed')).toBe(true);
      expect((sc.diff as string).includes('--- before')).toBe(true);
      expect((sc.diff as string).includes('+++ after')).toBe(true);
    });

    it('policy_diff MCP structuredContent matches CLI --json data exactly', async () => {
      const leftPath = path.join(tmp, 'left-parity.yaml');
      const rightPath = path.join(tmp, 'right-parity.yaml');
      fs.writeFileSync(leftPath, ['version: "0.2"', 'quiet_hours:', '  start: "22:00"', ''].join('\n'));
      fs.writeFileSync(rightPath, ['version: "0.2"', 'quiet_hours:', '  start: "23:00"', ''].join('\n'));

      const cliData = runPolicyDiffCliJson(leftPath, rightPath);
      const { client } = await pair();
      const mcp = await client.callTool({
        name: 'policy_diff',
        arguments: { left_path: leftPath, right_path: rightPath },
      });

      expect(mcp.isError).toBeFalsy();
      const sc = (mcp as { structuredContent?: Record<string, unknown> }).structuredContent!;
      expect(sc).toEqual(cliData);
    });
  });

  // ── riskProfile.idempotencyHint ──────────────────────────────────────────
  describe('send_command riskProfile.idempotencyHint', () => {
    type RiskProfile = { idempotencyHint: string; riskLevel: string; requiresConfirmation: boolean };
    type DryRunResponse = { ok: boolean; dryRun: boolean; riskProfile: RiskProfile; wouldSend: unknown };

    it('turnOn → idempotencyHint:safe (catalog says idempotent:true)', async () => {
      cacheMock.map.set('BOT1', { type: 'Bot', name: 'Test Bot', category: 'physical' });
      const { client } = await pair();
      const res = await client.callTool({ name: 'send_command', arguments: { deviceId: 'BOT1', command: 'turnOn', dryRun: true } });
      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as DryRunResponse;
      expect(sc.riskProfile.idempotencyHint).toBe('safe');
    });

    it('toggle → idempotencyHint:non-idempotent (catalog says idempotent:false)', async () => {
      cacheMock.map.set('PLUG1', { type: 'Plug Mini (US)', name: 'Test Plug', category: 'physical' });
      const { client } = await pair();
      const res = await client.callTool({ name: 'send_command', arguments: { deviceId: 'PLUG1', command: 'toggle', dryRun: true } });
      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as DryRunResponse;
      expect(sc.riskProfile.idempotencyHint).toBe('non-idempotent');
    });

    it('unlock (destructive, idempotent:true) → idempotencyHint:safe', async () => {
      cacheMock.map.set('LOCK1', { type: 'Smart Lock', name: 'Front Door', category: 'physical' });
      const { client } = await pair();
      // unlock is destructive — live path needs confirm:true
      const res = await client.callTool({ name: 'send_command', arguments: { deviceId: 'LOCK1', command: 'unlock', dryRun: true } });
      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as DryRunResponse;
      // destructive but catalog marks idempotent:true → hint should be safe
      expect(sc.riskProfile.idempotencyHint).toBe('safe');
      // riskLevel must still be high (it is destructive)
      expect(sc.riskProfile.riskLevel).toBe('high');
    });

    it('live path: turnOn → idempotencyHint:safe', async () => {
      cacheMock.map.set('BOT1', { type: 'Bot', name: 'Test Bot', category: 'physical' });
      apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });
      const { client } = await pair();
      const res = await client.callTool({ name: 'send_command', arguments: { deviceId: 'BOT1', command: 'turnOn' } });
      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as { ok: boolean; riskProfile: RiskProfile };
      expect(sc.riskProfile.idempotencyHint).toBe('safe');
    });

    it('live path: toggle → idempotencyHint:non-idempotent', async () => {
      cacheMock.map.set('PLUG1', { type: 'Plug Mini (US)', name: 'Test Plug', category: 'physical' });
      apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });
      const { client } = await pair();
      const res = await client.callTool({ name: 'send_command', arguments: { deviceId: 'PLUG1', command: 'toggle' } });
      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as { ok: boolean; riskProfile: RiskProfile };
      expect(sc.riskProfile.idempotencyHint).toBe('non-idempotent');
    });
  });
});
