import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as OsModule from 'node:os';
import axios from 'axios';
import { primeCredentials, __resetPrimedCredentials } from '../../src/credentials/prime.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const fixture = vi.hoisted(() => ({ home: '', token: 'old-token' }));
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof OsModule>();
  return { ...original, default: { ...original.default, homedir: () => fixture.home }, homedir: () => fixture.home };
});
vi.mock('../../src/credentials/keychain.js', () => ({
  selectCredentialStore: async () => ({
    get: async () => ({ token: fixture.token, secret: 'offline-secret' }),
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (fixture.home) rmSync(fixture.home, { recursive: true, force: true });
});

describe('MCP credential rotation', () => {
  it('uses rotated keychain credentials on the next tool request after expiry', async () => {
    fixture.home = mkdtempSync(join(tmpdir(), 'switchbot-mcp-refresh-'));
    fixture.token = 'old-token';
    vi.stubEnv('SWITCHBOT_TOKEN', '');
    vi.stubEnv('SWITCHBOT_SECRET', '');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
    const originalArgv = process.argv;
    process.argv = ['node', 'switchbot', '--no-quota'];
    const oldAdapter = axios.defaults.adapter;
    const authorizations: unknown[] = [];
    axios.defaults.adapter = async (config) => {
      authorizations.push(config.headers.Authorization);
      return { status: 200, statusText: 'OK', headers: {}, config,
        data: { statusCode: 100, body: { deviceId: 'BOT1', deviceType: 'Bot', power: 'ON' } } };
    };
    // Load CLI modules only after the isolated home is set: their filesystem
    // paths are cached during module initialization, so static import leaks scope.
    const { createSwitchBotMcpServer } = await import('../../src/commands/mcp.js');
    __resetPrimedCredentials();
    await primeCredentials('default');
    const server = createSwitchBotMcpServer({ toolProfile: 'readonly' });
    const client = new Client({ name: 'refresh-fixture', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await client.callTool({ name: 'get_device_status', arguments: { deviceId: 'BOT1' } });
      fixture.token = 'new-token';
      vi.setSystemTime(new Date('2026-10-12T00:00:06Z'));
      await client.callTool({ name: 'get_device_status', arguments: { deviceId: 'BOT1' } });
      expect(authorizations).toEqual(['old-token', 'new-token']);
    } finally {
      await client.close();
      await server.close();
      __resetPrimedCredentials();
      axios.defaults.adapter = oldAdapter;
      process.argv = originalArgv;
    }
  });
});
