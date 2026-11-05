import { describe, expect, it, vi } from 'vitest';
import axios, { type AxiosAdapter } from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const credentialsMock = vi.hoisted(() => ({
  get: vi.fn(async () => ({ token: 'camera-test-token', secret: 'camera-test-secret' })),
}));

vi.mock('../../src/credentials/keychain.js', () => ({
  selectCredentialStore: async () => credentialsMock,
}));

const cacheMock = vi.hoisted(() => ({
  devices: new Map<string, { type: string; name: string; category: 'physical' | 'ir' }>(),
  getCachedDevice: vi.fn((id: string) => cacheMock.devices.get(id) ?? null),
}));

vi.mock('../../src/devices/cache.js', () => ({
  getCachedDevice: cacheMock.getCachedDevice,
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

import { __resetPrimedCredentials } from '../../src/credentials/prime.js';
import { createSwitchBotMcpServer } from '../../src/commands/mcp.js';

async function pair() {
  const server = createSwitchBotMcpServer();
  const client = new Client({ name: 'camera-alignment-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('camera MCP safety alignment', () => {
  it('lists send_command, previews Solar camera motion disablement as high risk, and blocks default live execution', async () => {
    vi.stubEnv('SWITCHBOT_ALLOW_DIRECT_DESTRUCTIVE', '');
    const originalAdapter = axios.defaults.adapter;
    const fakeHttpAdapter: AxiosAdapter = vi.fn(async (config) => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
      data: { statusCode: 100, body: {} },
    }));
    axios.defaults.adapter = fakeHttpAdapter;
    cacheMock.devices.set('SOLAR-CAM-1', {
      type: 'Solar Pan/Tilt Cam 2K',
      name: 'Driveway Camera',
      category: 'physical',
    });
    __resetPrimedCredentials();

    let client: Client | undefined;
    let server: McpServer | undefined;
    try {
      ({ client, server } = await pair());

      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === 'send_command')).toBe(true);

      const preview = await client.callTool({
        name: 'send_command',
        arguments: {
          deviceId: 'SOLAR-CAM-1',
          command: 'disableMotionDetection',
          dryRun: true,
        },
      });
      expect(preview.isError).toBeFalsy();
      expect(preview.structuredContent).toMatchObject({
        ok: true,
        dryRun: true,
        riskProfile: {
          riskLevel: 'high',
          requiresConfirmation: true,
        },
      });

      const live = await client.callTool({
        name: 'send_command',
        arguments: {
          deviceId: 'SOLAR-CAM-1',
          command: 'disableMotionDetection',
          confirm: true,
        },
      });
      expect(live.isError).toBe(true);
      expect(live.structuredContent).toMatchObject({
        error: {
          kind: 'guard',
          code: 3,
          context: {
            directExecutionAllowed: false,
            requiredWorkflow: 'plan-approval',
          },
        },
      });
      expect(fakeHttpAdapter).not.toHaveBeenCalled();
    } finally {
      await client?.close();
      await server?.close();
      axios.defaults.adapter = originalAdapter;
      cacheMock.devices.clear();
      cacheMock.getCachedDevice.mockClear();
      credentialsMock.get.mockClear();
      vi.unstubAllEnvs();
      __resetPrimedCredentials();
    }
  });
});
