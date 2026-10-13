import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const children: ChildProcess[] = [];
const homes: string[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function startIsolatedMcp(keychainOnly = false): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), 'switchbot-http-profile-'));
  homes.push(home);
  // Run the real CLI HTTP handler. Only listen-port allocation is adapted:
  // Commander rejects port 0, so the harness delegates listen to a free port.
  const source = `
    const http = (await import('node:http')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const originalCreateServer = http.createServer;
    ${keychainOnly ? `
    // Simulate the external credential-store boundary, never the HTTP handler.
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const childProcess = (await import('node:child_process')).default;
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = (command, args, options) => {
      let output;
      if (command === 'which' && args[0] === 'secret-tool') output = 'isolated-secret-tool';
      if (command === 'secret-tool') {
        const account = args[args.indexOf('account') + 1];
        output = account === 'work:token' ? 'work-token' : account === 'work:secret' ? 'work-secret' : '';
      }
      if (output !== undefined) {
        return originalSpawn(process.execPath, ['-e', 'process.stdout.write(' + JSON.stringify(output) + ')'], options);
      }
      return originalSpawn(command, args, options);
    };
    const axios = (await import('axios')).default;
    axios.defaults.adapter = async (config) => ({
      status: 200, statusText: 'OK', headers: {}, config,
      data: { statusCode: 100, body: { deviceId: 'BOT1', deviceType: 'Bot',
        power: config.headers.Authorization === 'work-token' ? 'ON' : 'OFF' } },
    });
    ` : ''}
    http.createServer = (...args) => {
      const server = originalCreateServer(...args);
      const listen = server.listen.bind(server);
      server.listen = (_port, _host, callback) => listen(0, '127.0.0.1', () => {
        console.log('PROFILE_TEST_PORT=' + server.address().port);
        if (callback) callback();
      });
      return server;
    };
    syncBuiltinESMExports();
    process.argv = ['node', 'switchbot', ${keychainOnly ? '' : `'--config', ${JSON.stringify(join(home, 'absent.json'))},`} '--no-quota', 'mcp', 'serve', '--port', '1'];
    process.execArgv = [];
    await import('./src/index.ts');
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, PATH: '',
      SWITCHBOT_TOKEN: '', SWITCHBOT_SECRET: '', SWITCHBOT_MCP_TOKEN: 'isolated-profile-bearer' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  // Supported Node 18 lacks Promise.withResolvers; use its executor API.
  return new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    child.stderr!.on('data', (chunk) => { errors += chunk; });
    child.stdout!.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/PROFILE_TEST_PORT=(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`MCP exit ${code}: ${errors}`)));
  });
}

describe('HTTP MCP profile validation', () => {
  it('accepts keychain-only profiles without authorizing unknown profiles', async () => {
    const port = await startIsolatedMcp(true);
    const client = new Client({ name: 'keychain-profile-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer isolated-profile-bearer', 'x-switchbot-profile': 'work' } },
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'get_device_status', arguments: { deviceId: 'BOT1' } });
      expect(result.structuredContent).toMatchObject({ status: { deviceId: 'BOT1', power: 'ON' } });

      const unknown = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { Authorization: 'Bearer isolated-profile-bearer', 'x-switchbot-profile': 'missing',
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'profile-test', version: '1' },
        } }),
      });
      expect(unknown.status).toBe(401);
      expect(await unknown.json()).toMatchObject({ error: { code: -32001 } });
    } finally {
      await client.close();
    }
  });

  it('rejects an unsafe CLI profile even when a config override is supplied', () => {
    const home = mkdtempSync(join(tmpdir(), 'switchbot-cli-profile-'));
    homes.push(home);
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts',
      '--profile', '../config', '--config', join(home, 'absent.json'), 'config', 'show', '--json'], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, PATH: '',
        SWITCHBOT_TOKEN: 'offline-profile-token', SWITCHBOT_SECRET: 'offline-profile-secret' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: { kind: 'usage' } });
  });

  it.each([
    { header: '../config', query: '' },
    { header: undefined, query: '?profile=../config' },
    { header: '', query: '' },
  ])('returns a protocol error for an invalid explicit profile $header $query', async ({ header, query }) => {
    const port = await startIsolatedMcp();
    const response = await fetch(`http://127.0.0.1:${port}/mcp${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(header === undefined ? {} : { 'x-switchbot-profile': header }) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'profile-test', version: '1' },
      } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32602 } });
  });
});
