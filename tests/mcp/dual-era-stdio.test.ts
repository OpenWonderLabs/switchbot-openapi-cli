import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';

it('serves modern per-request discovery and offline tools alongside legacy initialization on stdio', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-stdio-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--config', join(home, 'absent.json'), 'mcp', 'serve', '--tools', 'readonly'], {
    env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, PATH: '', SWITCHBOT_TOKEN: '', SWITCHBOT_SECRET: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const request = async (method: string, params: object) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
    const line = await lines.next();
    expect(line.done).not.toBe(true);
    const message = JSON.parse(line.value);
    expect(message.id).toBe(id);
    return message;
  };
  const versionKey = 'io.modelcontextprotocol/protocolVersion';
  const _meta = { [versionKey]: '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
  try {
    const discover = await request('server/discover', { _meta });
    expect(discover.result).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private', capabilities: { tools: {}, resources: {} },
      supportedVersions: expect.arrayContaining(['2026-07-28', '2025-11-25']),
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'switchbot', version: expect.any(String) } } });
    const list = await request('tools/list', { _meta });
    expect(list.result).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' });
    const names = list.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('search_catalog');
    expect(names).not.toContain('send_command');
    const params = { name: 'search_catalog', arguments: { query: 'Bot', limit: 1 } };
    expect((await request('tools/call', { ...params, _meta })).result).toMatchObject({ resultType: 'complete', structuredContent: { total: 1 } });
    expect((await request('tools/call', { name: 'absent', arguments: {}, _meta })).error.code).toBe(-32602);
    expect((await request('resources/read', { uri: 'switchbot://events', _meta })).result).toMatchObject({
      contents: [{ uri: 'switchbot://events' }], ttlMs: 0, cacheScope: 'private',
    });
    expect((await request('tools/list', {})).error.code).toBe(-32602);
    expect((await request('tools/list', { _meta: { [versionKey]: '2026-07-28' } })).error.code).toBe(-32602);
    expect((await request('tools/list', { _meta: { ..._meta, [versionKey]: '2099-01-01' } })).error).toMatchObject({
      code: -32022, data: { requested: '2099-01-01', supported: expect.arrayContaining(['2026-07-28']) },
    });
    expect((await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result.protocolVersion).toBe('2025-11-25');
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const legacy = await request('tools/call', params);
    expect(legacy.result.structuredContent.total).toBe(1);
    expect(legacy.result).not.toHaveProperty('resultType');
  } finally {
    child.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);
