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

describe('MCP strict schemas — all tools reject unknown keys', () => {
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

  it('device_history (mode=raw) rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'device_history', { mode: 'raw' });
  });

  it('device_history (mode=query) rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'device_history', { mode: 'query', deviceId: 'D1' });
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

  it('device_history (mode=aggregate) rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'device_history', {
      mode: 'aggregate',
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

  it('policy_diff rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'policy_diff', {
      left_path: '/tmp/left.yaml',
      right_path: '/tmp/right.yaml',
    });
  });

  it('plan_run rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'plan_run', { plan: { version: '1.0', steps: [] } });
  });

  it('audit_query rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'audit_query', {});
  });

  it('audit_stats rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'audit_stats', {});
  });

  it('mindclip_recordings rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'mindclip_recordings', { action: 'list' });
  });

  it('mindclip_list_todos rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'mindclip_list_todos', {});
  });

  it('mindclip_recall rejects unknown keys', async () => {
    const { client } = await pair();
    await assertRejectsUnknownKey(client, 'mindclip_recall', { period: 'daily' });
  });
});

// ---------------------------------------------------------------------------
// G1: Discriminator schema validation for the consolidated tools.
// Each new tool requires `action`/`period`/`mode`. Both "missing" and
// "invalid value" must be rejected by the input schema layer (-32602), not
// silently routed to a default branch.
// ---------------------------------------------------------------------------

/** Assert that a tool call returns a schema validation error (-32602 family). */
async function assertSchemaReject(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
  pattern: RegExp = /-32602|invalid|Invalid|Required|enum|Expected/i,
) {
  const res = await client.callTool({ name: toolName, arguments: args });
  expect(res.isError, `${toolName} ${JSON.stringify(args)}: expected isError to be true`).toBe(true);
  const text = (res.content as Array<{ type: string; text: string }>)[0].text;
  expect(text, `${toolName} ${JSON.stringify(args)}: expected schema-level error`).toMatch(pattern);
}

describe('G1: discriminator schema validation for consolidated tools', () => {
  beforeEach(() => {
    apiMock.__instance.get.mockReset();
    apiMock.__instance.post.mockReset();
  });

  it('mindclip_recordings rejects missing action', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'mindclip_recordings', {});
  });

  it('mindclip_recordings rejects invalid action value', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'mindclip_recordings', { action: 'bogus' });
  });

  it('mindclip_recall rejects missing period', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'mindclip_recall', {});
  });

  it('mindclip_recall rejects invalid period value', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'mindclip_recall', { period: 'monthly' });
  });

  it('device_history rejects missing mode', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'device_history', {});
  });

  it('device_history rejects invalid mode value', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'device_history', { mode: 'firehose' });
  });
});

// ---------------------------------------------------------------------------
// G7: Boundary tests for filter ranges and regex patterns. These guard
// against accidentally relaxing min/max bounds or regex anchors during
// future refactors of the consolidated input schemas.
// ---------------------------------------------------------------------------

describe('G7: boundary values on consolidated tool filters', () => {
  beforeEach(() => {
    apiMock.__instance.get.mockReset();
    apiMock.__instance.post.mockReset();
  });

  // ── pageSize / pageNum on mindclip_recordings (action=list) and mindclip_list_todos
  it('mindclip_list_todos rejects pageSize=0', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'mindclip_list_todos', { pageSize: 0 });
  });

  it('mindclip_list_todos rejects pageSize=101', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'mindclip_list_todos', { pageSize: 101 });
  });

  it('mindclip_list_todos accepts pageSize=1 (min boundary)', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    const { client } = await pair();
    const res = await client.callTool({ name: 'mindclip_list_todos', arguments: { pageSize: 1 } });
    expect(res.isError).toBeFalsy();
  });

  it('mindclip_list_todos accepts pageSize=100 (max boundary)', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    const { client } = await pair();
    const res = await client.callTool({ name: 'mindclip_list_todos', arguments: { pageSize: 100 } });
    expect(res.isError).toBeFalsy();
  });

  it('mindclip_list_todos rejects pageNum=0', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'mindclip_list_todos', { pageNum: 0 });
  });

  it('mindclip_list_todos rejects completedNum=3', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'mindclip_list_todos', { completedNum: 3 });
  });

  it('mindclip_list_todos accepts completedNum=0..2', async () => {
    apiMock.__instance.get.mockResolvedValue({ data: { body: {} } });
    const { client } = await pair();
    for (const v of [0, 1, 2]) {
      const res = await client.callTool({ name: 'mindclip_list_todos', arguments: { completedNum: v } });
      expect(res.isError, `completedNum=${v}`).toBeFalsy();
    }
  });

  it('mindclip_list_todos rejects category=6', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'mindclip_list_todos', { category: 6 });
  });

  // ── date / week regex on mindclip_recall
  it('mindclip_recall rejects malformed date (slashes)', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'mindclip_recall', { period: 'daily', date: '2026/06/13' });
  });

  it('mindclip_recall rejects week=2026-W00 (out of regex range)', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'mindclip_recall', { period: 'weekly', week: '2026-W00' });
  });

  it('mindclip_recall rejects week=2026-W54 (out of regex range)', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'mindclip_recall', { period: 'weekly', week: '2026-W54' });
  });

  it('mindclip_recall accepts week=2026-W01 and week=2026-W53 (regex boundaries)', async () => {
    apiMock.__instance.get.mockResolvedValue({ data: { body: {} } });
    const { client } = await pair();
    for (const w of ['2026-W01', '2026-W53']) {
      const res = await client.callTool({ name: 'mindclip_recall', arguments: { period: 'weekly', week: w } });
      expect(res.isError, `week=${w}`).toBeFalsy();
    }
  });
});

// ---------------------------------------------------------------------------
// G8: aggregate metrics array must have ≥1 element; empty array [] must be
// rejected at the schema layer (-32602), not silently routed to a runtime error.
// get_device_history alias: empty-string deviceId must be rejected (-32602).
// ---------------------------------------------------------------------------

describe('G8: aggregate metrics min(1) + get_device_history empty deviceId', () => {
  beforeEach(() => {
    apiMock.__instance.get.mockReset();
    apiMock.__instance.post.mockReset();
  });

  it('device_history (aggregate) rejects metrics=[] at schema level', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'device_history', {
      mode: 'aggregate',
      deviceId: 'D1',
      metrics: [],
    });
  });

  it('aggregate_device_history (deprecated alias) rejects metrics=[] at schema level', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'aggregate_device_history', {
      deviceId: 'D1',
      metrics: [],
    });
  });

  it('device_history (aggregate) accepts metrics with ≥1 valid string', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    const { client } = await pair();
    const res = await client.callTool({ name: 'device_history', arguments: {
      mode: 'aggregate',
      deviceId: 'D1',
      metrics: ['temperature'],
    }});
    // Schema passes — runtime result may vary (empty history store); isError
    // is still acceptable here as long as it's a runtime error, not a -32602.
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).not.toMatch(/-32602|Array must contain at least/);
  });

  it('get_device_history (deprecated alias) rejects deviceId="" at schema level', async () => {
    const { client } = await pair();
    await assertSchemaReject(client, 'get_device_history', {
      deviceId: '',
    });
  });

  it('get_device_history with valid deviceId is accepted by the schema', async () => {
    const { client } = await pair();
    const res = await client.callTool({ name: 'get_device_history', arguments: {
      deviceId: 'D1',
    }});
    // Schema passes; runtime result from empty store is valid non-error JSON
    expect(res.isError).toBeFalsy();
  });
});
