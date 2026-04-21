import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
import { ApiError } from '../../src/api/client.js';

/** Connect a fresh server + client pair and return both. */
async function pair() {
  const server = createSwitchBotMcpServer();
  const client = new Client({ name: 'test', version: '0.0.1' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { server, client };
}

describe('mcp server', () => {
  beforeEach(() => {
    apiMock.__instance.get.mockReset();
    apiMock.__instance.post.mockReset();
    cacheMock.map.clear();
    cacheMock.getCachedDevice.mockClear();
    cacheMock.updateCacheFromDeviceList.mockClear();
  });

  it('exposes the eleven tools with titles and input schemas', async () => {
    const { client } = await pair();
    const { tools } = await client.listTools();

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'account_overview',
        'aggregate_device_history',
        'describe_device',
        'get_device_history',
        'get_device_status',
        'list_devices',
        'list_scenes',
        'query_device_history',
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

  it('describe_device returns capabilities with destructive flags surfaced', async () => {
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
    expect(unlock.destructive).toBe(true);
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
});
