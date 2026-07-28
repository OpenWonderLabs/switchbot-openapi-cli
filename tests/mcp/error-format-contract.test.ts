/**
 * Contract test for mcpError() content[0].text format.
 *
 * mcpError() MUST produce text in exactly this format:
 *   <kind> error (code <N>): <message>
 *   [optional hint line]
 *   --- structured ---
 *   { "error": { ... } }
 *
 * This test pins that contract. If the format changes in src/commands/mcp.ts,
 * this test fails — forcing explicit updates to all consumers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiMock = vi.hoisted(() => {
  const instance = { get: vi.fn(), post: vi.fn() };
  return { createClient: vi.fn(() => instance), __instance: instance };
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
  getCachedStatusEntry: vi.fn(() => null),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSwitchBotMcpServer } from '../../src/commands/mcp.js';
import { ApiError } from '../../src/api/client.js';
import { parseErrorText } from '../helpers/mcp-test-utils.js';

async function pair() {
  const server = createSwitchBotMcpServer({ toolProfile: 'all' });
  const client = new Client({ name: 'error-format-test', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client };
}

describe('mcpError() content text format contract', () => {
  beforeEach(() => {
    apiMock.__instance.get.mockReset();
  });

  it('content[0].text starts with a human-readable summary line', async () => {
    const { client } = await pair();
    apiMock.__instance.get.mockRejectedValueOnce(new ApiError('device not found', 190));

    const result = await client.callTool({
      name: 'describe_device',
      arguments: { deviceId: 'DOES_NOT_EXIST' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === 'text'
    )!.text;

    const firstLine = text.split('\n')[0];
    expect(firstLine).toMatch(/^(api|runtime|usage|guard) error \(code \d+\): .+/);
  });

  it('content[0].text contains the --- structured --- delimiter', async () => {
    const { client } = await pair();
    apiMock.__instance.get.mockRejectedValueOnce(new ApiError('not found', 190));

    const result = await client.callTool({
      name: 'describe_device',
      arguments: { deviceId: 'DOES_NOT_EXIST' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('--- structured ---');
  });

  it('the JSON after --- structured --- is parseable and contains an error key', async () => {
    const { client } = await pair();
    apiMock.__instance.get.mockRejectedValueOnce(new ApiError('not found', 190));

    const result = await client.callTool({
      name: 'describe_device',
      arguments: { deviceId: 'DOES_NOT_EXIST' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    const parsed = parseErrorText(text) as { error: { code: number; message: string } };
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toHaveProperty('code');
    expect(parsed.error).toHaveProperty('message');
  });

  it('structuredContent.error mirrors the JSON in content[0].text', async () => {
    const { client } = await pair();
    apiMock.__instance.get.mockRejectedValueOnce(new ApiError('not found', 190));

    const result = await client.callTool({
      name: 'describe_device',
      arguments: { deviceId: 'DOES_NOT_EXIST' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const fromText = parseErrorText(text) as { error: unknown };
    const fromStructured = (result as { structuredContent: { error: unknown } }).structuredContent;

    expect(fromText.error).toEqual(fromStructured.error);
  });
});
