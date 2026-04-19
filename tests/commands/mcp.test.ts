import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  getCachedTypeMap: vi.fn((ids?: Iterable<string>) => {
    const out = new Map<string, string>();
    if (ids) {
      for (const id of ids) {
        const entry = cacheMock.map.get(id);
        if (entry?.type) out.set(id, entry.type);
      }
    } else {
      for (const [id, entry] of cacheMock.map.entries()) {
        if (entry.type) out.set(id, entry.type);
      }
    }
    return out;
  }),
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

  it('exposes the expanded tool catalog with titles and input schemas', async () => {
    const { client } = await pair();
    const { tools } = await client.listTools();

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'describe_device',
        'devices_batch',
        'events_recent',
        'get_device_status',
        'list_devices',
        'list_scenes',
        'plan_run',
        'quota_status',
        'run_scene',
        'search_catalog',
        'send_command',
        'webhook_delete',
        'webhook_query',
        'webhook_setup',
        'webhook_update',
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

  it('devices_batch requires ids or filter', async () => {
    const { client } = await pair();
    const res = await client.callTool({
      name: 'devices_batch',
      arguments: { command: 'turnOff' },
    });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.error.kind).toBe('usage');
  });

  it('devices_batch fans a command across the supplied ids', async () => {
    cacheMock.map.set('B1', { type: 'Bot', name: 'Bot 1', category: 'physical' });
    cacheMock.map.set('B2', { type: 'Bot', name: 'Bot 2', category: 'physical' });
    apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'devices_batch',
      arguments: { command: 'turnOff', ids: ['B1', 'B2'] },
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.summary.total).toBe(2);
    expect(parsed.summary.ok).toBe(2);
  });

  it('devices_batch blocks destructive commands unless yes:true', async () => {
    cacheMock.map.set('L1', { type: 'Smart Lock', name: 'Lock', category: 'physical' });
    const { client } = await pair();
    const res = await client.callTool({
      name: 'devices_batch',
      arguments: { command: 'unlock', ids: ['L1'] },
    });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.error.kind).toBe('guard');
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
  });

  it('plan_run executes a simple wait+scene plan', async () => {
    apiMock.__instance.post.mockResolvedValueOnce({ data: { statusCode: 100, body: {} } });
    const { client } = await pair();
    const res = await client.callTool({
      name: 'plan_run',
      arguments: {
        plan: {
          version: '1.0',
          steps: [
            { type: 'wait', ms: 1 },
            { type: 'scene', sceneId: 'SC1' },
          ],
        },
      },
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.ran).toBe(true);
    expect(parsed.summary).toEqual({ total: 2, ok: 2, error: 0, skipped: 0 });
  });

  it('plan_run rejects an invalid plan shape', async () => {
    const { client } = await pair();
    const res = await client.callTool({
      name: 'plan_run',
      arguments: { plan: { version: '2.0', steps: [] } },
    });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.error.kind).toBe('usage');
  });

  it('webhook_setup rejects a non-http URL', async () => {
    const { client } = await pair();
    const res = await client.callTool({
      name: 'webhook_setup',
      arguments: { url: 'ftp://example.com/hook' },
    });
    expect(res.isError).toBe(true);
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
  });

  it('webhook_setup POSTs to the SwitchBot setup endpoint', async () => {
    apiMock.__instance.post.mockResolvedValueOnce({ data: { statusCode: 100, body: {} } });
    const { client } = await pair();
    const res = await client.callTool({
      name: 'webhook_setup',
      arguments: { url: 'https://example.com/hook' },
    });
    expect(res.isError).toBeFalsy();
    expect(apiMock.__instance.post).toHaveBeenCalledWith(
      '/v1.1/webhook/setupWebhook',
      expect.objectContaining({ url: 'https://example.com/hook', deviceList: 'ALL' }),
    );
  });

  it('quota_status returns today\'s local counter', async () => {
    const { client } = await pair();
    const res = await client.callTool({ name: 'quota_status', arguments: {} });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed).toMatchObject({
      date: expect.any(String),
      total: expect.any(Number),
      remaining: expect.any(Number),
      serverQuotaKnown: false,
    });
  });
});
