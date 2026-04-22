/**
 * Strict-schema tests (bug #4): every MCP tool must reject unknown input keys
 * with JSON-RPC -32602 / unrecognized_keys.
 *
 * SDK @1.29.0 returns { isError:true, content:[{type:'text', text:'MCP error -32602…'}] }
 * rather than throwing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — same boilerplate as mcp.test.ts
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

const cacheMock = vi.hoisted(() => ({
  map: new Map<string, { type: string; name: string; category: 'physical' | 'ir' }>(),
  getCachedDevice: vi.fn((id: string) => cacheMock.map.get(id) ?? null),
  updateCacheFromDeviceList: vi.fn(),
}));

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

async function pair() {
  const server = createSwitchBotMcpServer();
  const client = new Client({ name: 'test', version: '0.0.1' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { server, client };
}

/** Assert that a tool call with an extra unknown field returns a -32602 error. */
async function assertRejectsUnknownKey(
  client: Client,
  toolName: string,
  validArgs: Record<string, unknown>,
) {
  const args = { ...validArgs, fooBarBaz: true };
  const res = await client.callTool({ name: toolName, arguments: args });
  expect(res.isError, `${toolName}: expected isError to be true`).toBe(true);
  const text = (res.content as Array<{ type: string; text: string }>)[0].text;
  expect(text, `${toolName}: expected -32602 or unrecognized_keys`).toMatch(
    /-32602|unrecognized_keys|Unrecognized key/i,
  );
}

describe('MCP strict schemas — all 14 tools reject unknown keys', () => {
  beforeEach(() => {
    apiMock.__instance.get.mockReset();
    apiMock.__instance.post.mockReset();
    cacheMock.map.clear();
  });

  it('list_devices rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'list_devices', {});
  });

  it('get_device_status rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'get_device_status', { deviceId: 'D1' });
  });

  it('get_device_history rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'get_device_history', {});
  });

  it('query_device_history rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'query_device_history', { deviceId: 'D1' });
  });

  it('send_command rejects unknown keys', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'Kitchen Bot', category: 'physical' });
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'send_command', {
      deviceId: 'BOT1',
      command: 'turnOn',
    });
  });

  it('run_scene rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'run_scene', { sceneId: 'S1' });
  });

  it('list_scenes rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'list_scenes', {});
  });

  it('search_catalog rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'search_catalog', { query: 'Bot' });
  });

  it('describe_device rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'describe_device', { deviceId: 'D1' });
  });

  it('aggregate_device_history rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'aggregate_device_history', {
      deviceId: 'D1',
      metrics: ['temperature'],
    });
  });

  it('account_overview rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'account_overview', {});
  });

  it('policy_validate rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'policy_validate', {});
  });

  it('policy_new rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'policy_new', {});
  });

  it('policy_migrate rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'policy_migrate', {});
  });
});
