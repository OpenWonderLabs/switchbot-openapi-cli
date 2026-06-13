/**
 * Retired tools contract: 9 MCP tool names retired by the v3.8.0 consolidation
 * must NOT be registered, regardless of profile. They were replaced by:
 *   - mindclip_list_recordings, mindclip_get_recording, mindclip_get_summary
 *       -> mindclip_recordings (action: list | get | summary)
 *   - mindclip_daily_recall, mindclip_weekly_summary, mindclip_urgent_todos
 *       -> mindclip_recall (period: daily | weekly | urgent_todos)
 *   - get_device_history, query_device_history, aggregate_device_history
 *       -> device_history (mode: raw | query | aggregate)
 *
 * If any of these names ever returns to the registered set, this test guards
 * the breaking-change contract documented in CHANGELOG [Unreleased].
 */
import { describe, it, expect, vi } from 'vitest';

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

vi.mock('../../src/devices/cache.js', () => ({
  getCachedDevice: vi.fn(() => null),
  updateCacheFromDeviceList: vi.fn(),
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
import { createSwitchBotMcpServer, listRegisteredTools } from '../../src/commands/mcp.js';

const RETIRED = [
  'mindclip_list_recordings',
  'mindclip_get_recording',
  'mindclip_get_summary',
  'mindclip_daily_recall',
  'mindclip_weekly_summary',
  'mindclip_urgent_todos',
  'get_device_history',
  'query_device_history',
  'aggregate_device_history',
] as const;

async function pair(toolProfile: 'default' | 'readonly' | 'all' = 'all') {
  const server = createSwitchBotMcpServer({ toolProfile });
  const client = new Client({ name: 'retired-test', version: '0.0.1' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { server, client };
}

describe('retired MCP tool names (v3.8.0 consolidation contract)', () => {
  it.each(RETIRED)('%s is not in createSwitchBotMcpServer({ toolProfile: "all" })', (name) => {
    const server = createSwitchBotMcpServer({ toolProfile: 'all' });
    const tools = listRegisteredTools(server);
    expect(tools, `retired tool ${name} must not be registered under "all" profile`).not.toContain(name);
  });

  it.each(RETIRED)('%s is absent from listTools() over the wire', async (name) => {
    const { client } = await pair('all');
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names, `retired tool ${name} must not appear in listTools()`).not.toContain(name);
  });

  it.each(RETIRED)('%s callTool returns method-not-found / -32601', async (name) => {
    const { client } = await pair('all');
    let caught: unknown;
    try {
      // The SDK throws on tools/call against unregistered names rather than
      // returning an isError content envelope (the latter is for tool-handler
      // errors). Either shape is acceptable; both must surface "not found".
      const res = await client.callTool({ name, arguments: {} });
      // If the SDK ever stops throwing here, the result must still report error.
      expect(res.isError, `${name} should not be invokable`).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(text).toMatch(/-32601|not found|unknown tool|Method not found/i);
      return;
    } catch (err) {
      caught = err;
    }
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg, `${name} expected method-not-found in error`).toMatch(
      /-32601|not found|unknown tool|Method not found/i,
    );
  });
});
