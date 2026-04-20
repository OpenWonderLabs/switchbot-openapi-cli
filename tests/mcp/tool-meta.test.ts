/**
 * MCP tool _meta.agentSafetyTier test — bug #6
 *
 * Verifies that every MCP tool has _meta.agentSafetyTier set to one of
 * 'read' | 'action' | 'destructive', and spot-checks specific expected tiers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — same boilerplate as strict-schemas.test.ts
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

describe('MCP tool _meta.agentSafetyTier', () => {
  beforeEach(() => {
    apiMock.__instance.get.mockReset();
    apiMock.__instance.post.mockReset();
    cacheMock.map.clear();
  });

  it('every tool has _meta.agentSafetyTier set to read | action | destructive', async () => {
    const { client } = await pair();

    const toolsList = await client.listTools();
    expect(toolsList.tools.length).toBeGreaterThan(0);

    for (const tool of toolsList.tools) {
      const meta = (tool as any)._meta;
      expect(meta, `${tool.name} must have _meta field`).toBeDefined();
      expect(meta.agentSafetyTier, `${tool.name} must have agentSafetyTier`).toBeDefined();
      expect(
        ['read', 'action', 'destructive'].includes(meta.agentSafetyTier),
        `${tool.name} agentSafetyTier must be 'read' | 'action' | 'destructive', got: ${meta.agentSafetyTier}`
      ).toBe(true);
    }
  });

  it('send_command is marked as action tier', async () => {
    const { client } = await pair();
    const toolsList = await client.listTools();
    const tool = toolsList.tools.find((t) => t.name === 'send_command');
    expect(tool).toBeDefined();
    expect((tool as any)._meta.agentSafetyTier).toBe('action');
  });

  it('run_scene is marked as action tier', async () => {
    const { client } = await pair();
    const toolsList = await client.listTools();
    const tool = toolsList.tools.find((t) => t.name === 'run_scene');
    expect(tool).toBeDefined();
    expect((tool as any)._meta.agentSafetyTier).toBe('action');
  });

  it('list_devices is marked as read tier', async () => {
    const { client } = await pair();
    const toolsList = await client.listTools();
    const tool = toolsList.tools.find((t) => t.name === 'list_devices');
    expect(tool).toBeDefined();
    expect((tool as any)._meta.agentSafetyTier).toBe('read');
  });

  it('aggregate_device_history is marked as read tier', async () => {
    const { client } = await pair();
    const toolsList = await client.listTools();
    const tool = toolsList.tools.find((t) => t.name === 'aggregate_device_history');
    expect(tool).toBeDefined();
    expect((tool as any)._meta.agentSafetyTier).toBe('read');
  });
});
