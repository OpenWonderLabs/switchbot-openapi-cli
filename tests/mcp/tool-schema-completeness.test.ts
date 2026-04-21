/**
 * P4: MCP tool schema completeness (N-6 fix-check).
 *
 * Every registered MCP tool must:
 *  - have a non-empty title + description at the tool level
 *  - expose inputSchema as a JSON Schema of type "object"
 *  - annotate every input property with a non-empty `description`
 *    (so agents can introspect argument intent without reading source)
 *  - expose an outputSchema (so the Inspector / clients can verify tool returns)
 *
 * Tools taking no input ({}) are exempt from the per-property check — there
 * are no properties to describe — but the object still must be present.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

const apiMock = vi.hoisted(() => ({
  createClient: vi.fn(() => ({ get: vi.fn(), post: vi.fn() })),
}));

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
import { createSwitchBotMcpServer } from '../../src/commands/mcp.js';

interface JsonSchemaProp {
  type?: string | string[];
  description?: string;
  [k: string]: unknown;
}

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
  [k: string]: unknown;
}

interface ToolShape {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonSchemaObject;
  outputSchema?: JsonSchemaObject;
}

describe('MCP tool schema completeness', () => {
  let tools: ToolShape[];

  beforeAll(async () => {
    const server = createSwitchBotMcpServer();
    const client = new Client({ name: 'schema-completeness-test', version: '0.0.0' });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const list = await client.listTools();
    tools = list.tools as unknown as ToolShape[];
  });

  it('at least 10 tools are registered', () => {
    expect(tools.length).toBeGreaterThanOrEqual(10);
  });

  it('every tool has a non-empty title and description', () => {
    for (const tool of tools) {
      expect(tool.title, `${tool.name} missing title`).toBeTypeOf('string');
      expect((tool.title ?? '').length, `${tool.name} empty title`).toBeGreaterThan(0);
      expect(tool.description, `${tool.name} missing description`).toBeTypeOf('string');
      expect((tool.description ?? '').length, `${tool.name} empty description`).toBeGreaterThan(0);
    }
  });

  it('every tool exposes an inputSchema of type "object"', () => {
    for (const tool of tools) {
      expect(tool.inputSchema, `${tool.name} missing inputSchema`).toBeDefined();
      expect(tool.inputSchema?.type, `${tool.name} inputSchema.type should be "object"`).toBe('object');
    }
  });

  it('every property of every inputSchema has a non-empty description', () => {
    const offenders: string[] = [];
    for (const tool of tools) {
      const props = tool.inputSchema?.properties;
      if (!props) continue; // no inputs — ok
      for (const [propName, propSpec] of Object.entries(props)) {
        const desc = propSpec.description;
        if (typeof desc !== 'string' || desc.trim().length === 0) {
          offenders.push(`${tool.name}.${propName}`);
        }
      }
    }
    expect(
      offenders,
      `Tool input properties missing .describe():\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every tool exposes an outputSchema (so Inspector / MCP clients can validate returns)', () => {
    const offenders: string[] = [];
    for (const tool of tools) {
      if (!tool.outputSchema || typeof tool.outputSchema !== 'object') {
        offenders.push(tool.name);
      }
    }
    expect(
      offenders,
      `Tools without an outputSchema:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('aggregate_device_history describes every input argument (P4 regression guard)', () => {
    const agg = tools.find((t) => t.name === 'aggregate_device_history');
    expect(agg, 'aggregate_device_history must be registered').toBeDefined();
    const props = agg!.inputSchema?.properties ?? {};
    const expected = ['deviceId', 'since', 'from', 'to', 'metrics', 'aggs', 'bucket', 'maxBucketSamples'];
    for (const prop of expected) {
      expect(props[prop], `${prop} should appear in aggregate_device_history inputSchema`).toBeDefined();
      expect(
        props[prop].description,
        `${prop}.description should be a non-empty string`,
      ).toBeTypeOf('string');
      expect((props[prop].description ?? '').length).toBeGreaterThan(0);
    }
  });
});
