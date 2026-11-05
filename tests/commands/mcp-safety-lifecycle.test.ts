import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSwitchBotMcpServer } from '../../src/commands/mcp.js';
import { resetListCache, resetStatusCache } from '../../src/devices/cache.js';
import { idempotencyCache } from '../../src/lib/idempotency.js';
import { publishCredentialRevision, readCredentialScope } from '../../src/credentials/scope.js';
import { __resetPrimedCredentials } from '../../src/credentials/prime.js';
import { createFileBackend } from '../../src/credentials/backends/file.js';
import { saveConfig } from '../../src/config.js';
import type * as CredentialStoreModule from '../../src/credentials/keychain.js';

const credentialStoreMock = vi.fn();
vi.mock('../../src/credentials/keychain.js', async () => {
  const actual = await vi.importActual<typeof CredentialStoreModule>(
    '../../src/credentials/keychain.js',
  );
  return { ...actual, selectCredentialStore: (...args: unknown[]) => credentialStoreMock(...args) };
});

const originalArgv = process.argv;
const originalAdapter = axios.defaults.adapter;
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-mcp-safety-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  vi.stubEnv('SWITCHBOT_TOKEN', 'test-only-token');
  vi.stubEnv('SWITCHBOT_SECRET', 'test-only-secret');
  vi.stubEnv('SWITCHBOT_ALLOW_DIRECT_DESTRUCTIVE', '');
  process.argv = ['node', 'switchbot', '--config', path.join(tmp, 'config.json'), '--no-quota', '--no-retry'];
  resetListCache();
  resetStatusCache();
  idempotencyCache.clear();
  __resetPrimedCredentials();
  credentialStoreMock.mockReset();
});

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
  process.argv = originalArgv;
  resetListCache();
  resetStatusCache();
  idempotencyCache.clear();
  __resetPrimedCredentials();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function connectMcp() {
  const server = createSwitchBotMcpServer({ toolProfile: 'all' });
  const client = new Client({ name: 'safety-regression', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  await client.listTools();
  return { server, client };
}

describe('MCP Light Bars live parameter validation', () => {
  it.each([
    { command: 'setBrightnessAndTemperature', field: 'brightness', min: 0, max: 100, base: { brightness: 50, temperature: 2700 } },
    { command: 'setBrightnessAndTemperature', field: 'temperature', min: 2700, max: 6500, base: { brightness: 0, temperature: 2700 } },
    { command: 'setMusicParamMode', field: 'musicMode', min: 0, max: 5, base: { musicMode: 0, musicLevel: 1, sensitivity: 100, controllerMode: 2 } },
    { command: 'setMusicParamMode', field: 'musicLevel', min: 1, max: 100, base: { musicMode: 0, musicLevel: 1, sensitivity: 100, controllerMode: 2 } },
    { command: 'setMusicParamMode', field: 'sensitivity', min: 1, max: 100, base: { musicMode: 0, musicLevel: 1, sensitivity: 100, controllerMode: 2 } },
    { command: 'setMusicParamMode', field: 'controllerMode', min: 0, max: 2, base: { musicMode: 0, musicLevel: 1, sensitivity: 100, controllerMode: 2 } },
    { command: 'setEffectSpeedMode', field: 'speed', min: 1, max: 255, base: { speed: 1 } },
    { command: 'setSegmentColorMode', field: 'lightIndex', min: 0, max: 11, base: { color: '0:0:255', lightIndex: 0 } },
    { command: 'setLightEffect', field: 'effectId', min: 0, max: 25, base: { effectId: 0 } },
  ])('enforces $command.$field boundaries before dispatch', async ({ command, field, min, max, base }) => {
    const posts: unknown[] = [];
    axios.defaults.adapter = async config => {
      if (config.method === 'post') posts.push(JSON.parse(String(config.data)));
      return { status: 200, statusText: 'OK', headers: {}, config, data: { statusCode: 100,
        body: config.method === 'get' ? {
          deviceList: [{ deviceId: 'BARS1', deviceName: 'Bars', deviceType: 'RGBICWW Light Bars', enableCloudService: true }],
          infraredRemoteList: [],
        } : {},
      } };
    };
    const { client, server } = await connectMcp();
    try {
      for (const value of [min - 1, max + 1, min + 0.5, String(min), null, undefined]) {
        const rejected = await client.callTool({
          name: 'send_command', arguments: { deviceId: 'BARS1', command, parameter: { ...base, [field]: value } },
        });
        expect(rejected.isError, `${field}=${value}`).toBe(true);
        expect(posts).toEqual([]);
      }
      for (const value of [min, max]) {
        const accepted = await client.callTool({
          name: 'send_command', arguments: { deviceId: 'BARS1', command, parameter: { ...base, [field]: value } },
        });
        expect(accepted.structuredContent).toMatchObject({ ok: true });
      }
      expect(posts).toEqual([min, max].map(value => ({
        command, parameter: { ...base, [field]: value }, commandType: 'command',
      })));
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('MCP resolved device type safety', () => {
  it('returns a structured error for unavailable replacement credentials and recovers after unlocking', async () => {
    vi.stubEnv('SWITCHBOT_TOKEN', '');
    vi.stubEnv('SWITCHBOT_SECRET', '');
    process.argv = ['node', 'switchbot', '--no-quota', '--no-retry'];
    saveConfig('obsolete-file-token', 'obsolete-file-secret');
    publishCredentialRevision(readCredentialScope(), true);
    credentialStoreMock.mockRejectedValue(new Error('keychain locked'));
    const dispatched: string[] = [];
    axios.defaults.adapter = async config => {
      const account = String(config.headers.Authorization);
      dispatched.push(account);
      return { status: 200, statusText: 'OK', headers: {}, config,
        data: { statusCode: 100, body: { deviceId: 'BOT1', deviceType: 'Bot', power: 'ON', account } } };
    };
    const { client, server } = await connectMcp();
    try {
      const failed = await client.callTool({ name: 'get_device_status', arguments: { deviceId: 'BOT1' } });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({ error: { kind: 'runtime', code: 1 } });
      expect(dispatched).toEqual([]);

      credentialStoreMock.mockResolvedValue({
        ...createFileBackend(), name: 'keychain',
        get: async () => ({ token: 'replacement-token', secret: 'replacement-secret' }),
      });
      const recovered = await client.callTool({ name: 'get_device_status', arguments: { deviceId: 'BOT1' } });
      expect(recovered.structuredContent).toMatchObject({ status: { deviceId: 'BOT1', account: 'replacement-token' } });
      expect(dispatched).toEqual(['replacement-token']);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    ['Solar Pan/Tilt Cam 2K', 'controlType', 'disableMotionDetection'],
    ['Smart Lock Ultra Max', 'controlType', 'Unlock'],
    ['Smart Lock Ultra Max', 'deviceType', 'UNLOCK'],
  ])('blocks %s via %s before and after warming the cache', async (deviceType, typeField, command) => {
    let gets = 0;
    const posts: unknown[] = [];
    axios.defaults.adapter = async (config) => {
      if (config.method === 'post') posts.push(JSON.parse(String(config.data)));
      if (config.method === 'get') gets++;
      return {
        status: 200, statusText: 'OK', headers: {}, config,
        data: {
          statusCode: 100,
          body: config.method === 'get' ? {
            deviceList: [{
              deviceId: 'TARGET-1', deviceName: 'Target', [typeField]: deviceType,
              enableCloudService: true, hubDeviceId: '',
            }],
            infraredRemoteList: [],
          } : {},
        },
      };
    };
    const { client, server } = await connectMcp();
    try {
      for (const cacheState of ['cold', 'warm']) {
        const response = await client.callTool({
          name: 'send_command',
          arguments: { deviceId: 'TARGET-1', command, confirm: false },
        });
        expect(response.isError, cacheState).toBe(true);
        expect(response.structuredContent).toMatchObject({
          error: { kind: 'guard', context: { directExecutionAllowed: false, deviceType } },
        });
      }
      const preview = await client.callTool({
        name: 'send_command',
        arguments: { deviceId: 'TARGET-1', command, dryRun: true },
      });
      expect(preview.structuredContent).toMatchObject({
        ok: true,
        riskProfile: { riskLevel: 'high', requiresConfirmation: true },
      });
      expect(gets).toBe(1);
      expect(posts).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('still requires confirmation with an explicit direct-execution override', async () => {
    vi.stubEnv('SWITCHBOT_ALLOW_DIRECT_DESTRUCTIVE', '1');
    const posts: unknown[] = [];
    axios.defaults.adapter = async (config) => {
      if (config.method === 'post') posts.push(JSON.parse(String(config.data)));
      return {
        status: 200, statusText: 'OK', headers: {}, config,
        data: {
          statusCode: 100,
          body: config.method === 'get' ? {
            deviceList: [{
              deviceId: 'LOCK-1', deviceName: 'Lock', controlType: 'Smart Lock Ultra Max',
              enableCloudService: true, hubDeviceId: '',
            }],
            infraredRemoteList: [],
          } : {},
        },
      };
    };
    const { client, server } = await connectMcp();
    try {
      const refused = await client.callTool({
        name: 'send_command',
        arguments: { deviceId: 'LOCK-1', command: 'Unlock', confirm: false },
      });
      expect(refused.isError).toBe(true);
      expect(posts).toEqual([]);
      const confirmed = await client.callTool({
        name: 'send_command',
        arguments: { deviceId: 'LOCK-1', command: 'Unlock', confirm: true },
      });
      expect(confirmed.structuredContent).toMatchObject({
        ok: true, command: 'unlock', riskProfile: { riskLevel: 'high' },
      });
      expect(posts).toEqual([{ command: 'unlock', parameter: 'default', commandType: 'command' }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps genuine IR custom buttons available after a cold lookup', async () => {
    const posts: unknown[] = [];
    axios.defaults.adapter = async (config) => {
      if (config.method === 'post') posts.push(JSON.parse(String(config.data)));
      return {
        status: 200, statusText: 'OK', headers: {}, config,
        data: {
          statusCode: 100,
          body: config.method === 'get' ? {
            deviceList: [],
            infraredRemoteList: [{
              deviceId: 'IR-1', deviceName: 'Remote', remoteType: 'Others', hubDeviceId: '',
            }],
          } : {},
        },
      };
    };
    const { client, server } = await connectMcp();
    try {
      const response = await client.callTool({
        name: 'send_command',
        arguments: { deviceId: 'IR-1', command: 'Movie mode', commandType: 'customize' },
      });
      expect(response.structuredContent).toMatchObject({ ok: true, verification: { verifiable: false } });
      expect(posts).toEqual([{ command: 'Movie mode', parameter: 'default', commandType: 'customize' }]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('MCP exclusive output contract', () => {
  it.each([
    { name: 'missing required success fields', structuredContent: {}, isError: false },
    {
      name: 'mixed success and error fields',
      structuredContent: { ok: true, error: { code: 2, kind: 'usage', message: 'invalid input' } },
      isError: true,
    },
    {
      name: 'incorrectly typed error fields',
      structuredContent: { error: { code: '2', kind: 'usage', message: 'invalid input' } },
      isError: true,
    },
  ])('rejects $name after SDK discovery', async ({ structuredContent, isError }) => {
    const registrations = vi.spyOn(McpServer.prototype, 'registerTool');
    const { client, server } = await connectMcp();
    try {
      const index = registrations.mock.calls.findIndex(([name]) => name === 'send_command');
      const registered = registrations.mock.results[index];
      if (registered?.type !== 'return') throw new Error('send_command was not registered');
      registered.value.update({
        callback: async () => ({
          content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
          structuredContent,
          isError,
        }),
      });
      const response = client.callTool({
        name: 'send_command',
        arguments: { deviceId: 'TARGET-1', command: 'turnOn', dryRun: true },
      });
      if (isError) {
        // The SDK validates error payloads against the published JSON Schema.
        await expect(response).rejects.toMatchObject({ code: -32602 });
      } else {
        // The server validates success payloads before returning them.
        const rejected = await response;
        expect(rejected.isError).toBe(true);
        expect(rejected.structuredContent).toBeUndefined();
      }
    } finally {
      registrations.mockRestore();
      await client.close();
      await server.close();
    }
  });
});
