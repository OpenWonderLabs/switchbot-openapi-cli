/**
 * Legacy alias contract: 3 device_history MCP tool names retired by the 3.8.0
 * consolidation are kept registered as deprecated aliases that delegate to the
 * consolidated `device_history` tool. Removal is scheduled for 4.0.0
 * (see CHANGELOG).
 *
 *   - get_device_history       -> device_history(mode="raw")
 *   - query_device_history     -> device_history(mode="query")
 *   - aggregate_device_history -> device_history(mode="aggregate")
 *
 * The 6 retired mindclip names (mindclip_list_recordings / _get_recording /
 * _get_summary / _daily_recall / _weekly_summary / _urgent_todos) are NOT
 * aliased — they were both added and renamed on the unreleased 3.8.0 branch,
 * so no published 3.x client could have used them. This test also guards
 * against accidentally re-registering them (extra schemas = wasted tokens).
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
import {
  createSwitchBotMcpServer,
  listRegisteredTools,
} from '../../src/commands/mcp.js';

const ALIASES = [
  { old: 'get_device_history',       discriminator: 'mode="raw"' },
  { old: 'query_device_history',     discriminator: 'mode="query"' },
  { old: 'aggregate_device_history', discriminator: 'mode="aggregate"' },
] as const;

const NEVER_SHIPPED = [
  'mindclip_list_recordings',
  'mindclip_get_recording',
  'mindclip_get_summary',
  'mindclip_daily_recall',
  'mindclip_weekly_summary',
  'mindclip_urgent_todos',
] as const;

async function pair(toolProfile: 'default' | 'readonly' | 'all' = 'all') {
  const server = createSwitchBotMcpServer({ toolProfile });
  const client = new Client({ name: 'alias-test', version: '0.0.1' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { server, client };
}

describe('legacy device_history aliases (3.8.0 backward-compat contract)', () => {
  it.each(ALIASES.map((a) => a.old))(
    '%s is registered under readonly / default / all',
    (name) => {
      for (const profile of ['readonly', 'default', 'all'] as const) {
        const server = createSwitchBotMcpServer({ toolProfile: profile });
        const tools = listRegisteredTools(server);
        expect(
          tools,
          `alias ${name} must be registered under profile=${profile}`,
        ).toContain(name);
      }
    },
  );

  it.each(ALIASES.map((a) => a.old))(
    '%s appears in listTools() over the wire',
    async (name) => {
      const { client } = await pair('all');
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names, `alias ${name} must appear in listTools()`).toContain(name);
    },
  );

  it.each(ALIASES)(
    '$old description starts with [DEPRECATED ...] and references device_history($discriminator)',
    async ({ old, discriminator }) => {
      const { client } = await pair('all');
      const { tools } = await client.listTools();
      const t = tools.find((x) => x.name === old);
      expect(t, `alias ${old} not found`).toBeDefined();
      expect(t!.description ?? '').toMatch(/^\[DEPRECATED/i);
      expect(t!.description ?? '').toContain('device_history');
      expect(t!.description ?? '').toContain(discriminator);
    },
  );

  it.each(ALIASES)(
    '$old declares _meta.deprecated=true and _meta.replacement="device_history"',
    async ({ old }) => {
      const { client } = await pair('all');
      const { tools } = await client.listTools();
      const t = tools.find((x) => x.name === old) as
        | { name: string; _meta?: { deprecated?: boolean; replacement?: string } }
        | undefined;
      expect(t, `alias ${old} not found`).toBeDefined();
      expect(t!._meta, `${old}: _meta not transmitted by SDK — check Tool type definition`).toBeDefined();
      expect(t!._meta?.deprecated).toBe(true);
      expect(t!._meta?.replacement).toBe('device_history');
    },
  );

  it('get_device_history forwards equivalently to device_history({mode:"raw"})', async () => {
    const { client } = await pair('all');
    // Use a no-such-device arg so neither call snapshots live MQTT real-time
    // data — both should produce the same empty-history envelope. Calling with
    // empty `arguments` would race on `latest.t` timestamps.
    const args = { deviceId: 'NO-SUCH-DEVICE' };
    const aliasResp = await client.callTool({ name: 'get_device_history', arguments: args });
    const consolidatedResp = await client.callTool({ name: 'device_history', arguments: { mode: 'raw', ...args } });
    expect(aliasResp.structuredContent).toEqual(consolidatedResp.structuredContent);
    expect(aliasResp.isError).toBe(consolidatedResp.isError);
  });

  it('query_device_history forwards equivalently to device_history({mode:"query"})', async () => {
    const { client } = await pair('all');
    // Query without setting up real device history; both calls should produce
    // the same shape (likely an error envelope or empty-records envelope).
    const args = { deviceId: 'NO-SUCH-DEVICE', since: '1h' };
    const aliasResp = await client.callTool({ name: 'query_device_history', arguments: args });
    const consolidatedResp = await client.callTool({ name: 'device_history', arguments: { mode: 'query', ...args } });
    expect(aliasResp.structuredContent).toEqual(consolidatedResp.structuredContent);
    expect(aliasResp.isError).toBe(consolidatedResp.isError);
  });

  it('aggregate_device_history forwards equivalently to device_history({mode:"aggregate"})', async () => {
    const { client } = await pair('all');
    const args = { deviceId: 'NO-SUCH-DEVICE', since: '1h', metrics: ['temperature'] };
    const aliasResp = await client.callTool({ name: 'aggregate_device_history', arguments: args });
    const consolidatedResp = await client.callTool({ name: 'device_history', arguments: { mode: 'aggregate', ...args } });
    expect(aliasResp.isError).toBe(consolidatedResp.isError);
    // Both responses should have the same structure. Timestamps (from/to) will
    // differ by a few ms across two separate calls, so compare the stable fields.
    const stable = (sc: unknown) => {
      if (!sc || typeof sc !== 'object') return sc;
      const { from: _f, to: _t, ...rest } = sc as Record<string, unknown>;
      return rest;
    };
    expect(stable(aliasResp.structuredContent)).toEqual(stable(consolidatedResp.structuredContent));
  });
});

describe('mindclip retired names (never shipped — must NOT be re-registered)', () => {
  it.each(NEVER_SHIPPED)('%s is absent from listRegisteredTools under all profile', (name) => {
    const server = createSwitchBotMcpServer({ toolProfile: 'all' });
    const tools = listRegisteredTools(server);
    expect(
      tools,
      `${name} was never published — it must not be registered (would bloat schemas without compat benefit)`,
    ).not.toContain(name);
  });

  it('mindclip_list_recordings callTool returns method-not-found / -32601 (representative)', async () => {
    const { client } = await pair('all');
    let caught: unknown;
    try {
      const res = await client.callTool({ name: 'mindclip_list_recordings', arguments: {} });
      // SDK may return error envelope rather than throwing — either is acceptable, both must say "not found".
      expect(res.isError, 'mindclip_list_recordings should not be invokable').toBe(true);
      const text = (res.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(text).toMatch(/-32601|not found|unknown tool|Method not found/i);
      return;
    } catch (err) {
      caught = err;
    }
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).toMatch(/-32601|not found|unknown tool|Method not found/i);
  });
});
