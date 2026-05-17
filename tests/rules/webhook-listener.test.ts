import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { WebhookListener } from '../../src/rules/webhook-listener.js';
import type { Rule, EngineEvent } from '../../src/rules/types.js';
import { readAudit } from '../../src/utils/audit.js';

function webhookRule(name: string, wpath: string): Rule {
  return {
    name,
    when: { source: 'webhook', path: wpath },
    then: [{ command: 'devices command <id> turnOn', device: 'lamp' }],
    dry_run: true,
  };
}

async function postTo(
  port: number,
  reqPath: string,
  opts: { token?: string; body?: string; method?: string; contentType?: string } = {},
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.contentType !== undefined) headers['Content-Type'] = opts.contentType;
  const res = await fetch(`http://127.0.0.1:${port}${reqPath}`, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body,
  });
  const body = await res.text();
  return { status: res.status, body };
}

describe('WebhookListener', () => {
  const originalArgv = process.argv;
  let tmp: string;
  let auditFile: string;
  let listener: WebhookListener | null;
  let fires: Array<{ rule: Rule; event: EngineEvent }>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-listener-'));
    auditFile = path.join(tmp, 'audit.log');
    process.argv = ['node', 'cli', '--audit-log', '--audit-log-path', auditFile];
    fires = [];
    listener = null;
  });
  afterEach(async () => {
    process.argv = originalArgv;
    if (listener) await listener.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function startListener(rules: Rule[], token = 'secret-bearer'): Promise<number> {
    listener = new WebhookListener({
      rules,
      bearerToken: token,
      host: '127.0.0.1',
      port: 0,
      dispatch: async (rule, event) => {
        fires.push({ rule, event });
      },
    });
    await listener.start();
    const port = listener.getPort();
    if (!port) throw new Error('listener did not bind a port');
    return port;
  }

  it('dispatches an event for a valid authorised POST to a known path', async () => {
    const rule = webhookRule('doorbell', '/doorbell');
    const port = await startListener([rule]);
    const res = await postTo(port, '/doorbell', { token: 'secret-bearer', body: '{"visitor":"alice"}' });
    expect(res.status).toBe(202);
    expect(fires).toHaveLength(1);
    expect(fires[0].rule.name).toBe('doorbell');
    expect(fires[0].event.source).toBe('webhook');
    expect((fires[0].event.payload as { body?: string }).body).toBe('{"visitor":"alice"}');
  });

  it('rejects requests missing the Authorization header with 401', async () => {
    const port = await startListener([webhookRule('doorbell', '/doorbell')]);
    const res = await postTo(port, '/doorbell');
    expect(res.status).toBe(401);
    expect(fires).toHaveLength(0);
    const audit = readAudit(auditFile);
    expect(audit.find((a) => a.kind === 'rule-webhook-rejected' && a.error === 'unauthorized')).toBeDefined();
  });

  it('rejects requests with a wrong bearer token with 401', async () => {
    const port = await startListener([webhookRule('doorbell', '/doorbell')], 'correct');
    const res = await postTo(port, '/doorbell', { token: 'wrong' });
    expect(res.status).toBe(401);
    expect(fires).toHaveLength(0);
  });

  it('returns 404 for an unknown path even when authorised', async () => {
    const port = await startListener([webhookRule('doorbell', '/doorbell')]);
    const res = await postTo(port, '/not-registered', { token: 'secret-bearer' });
    expect(res.status).toBe(404);
    expect(fires).toHaveLength(0);
    const audit = readAudit(auditFile);
    expect(audit.find((a) => a.kind === 'rule-webhook-rejected' && a.error === 'unknown-path')).toBeDefined();
  });

  it('rejects non-POST methods with 405 Allow: POST', async () => {
    const port = await startListener([webhookRule('doorbell', '/doorbell')]);
    const res = await postTo(port, '/doorbell', { token: 'secret-bearer', method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('normalises trailing slash and query string for path lookup', async () => {
    const port = await startListener([webhookRule('doorbell', '/doorbell')]);
    const res = await postTo(port, '/doorbell/?ignored=1', { token: 'secret-bearer' });
    expect(res.status).toBe(202);
    expect(fires).toHaveLength(1);
  });

  it('throws during construction when two rules share a path', () => {
    expect(
      () =>
        new WebhookListener({
          rules: [webhookRule('a', '/hit'), webhookRule('b', '/hit')],
          bearerToken: 't',
          port: 0,
          dispatch: async () => undefined,
        }),
    ).toThrow(/duplicate webhook path/);
  });

  it('listPaths returns every registered, normalised path', async () => {
    await startListener([webhookRule('a', '/a/'), webhookRule('b', '/b')]);
    expect(listener!.listPaths()).toEqual(['/a', '/b']);
  });

  it('uses constant-time comparison (wrong-length bearer still 401, no crash)', async () => {
    const port = await startListener([webhookRule('doorbell', '/doorbell')], 'short');
    const res = await postTo(port, '/doorbell', { token: 'a-much-longer-token-that-differs' });
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Lifecycle: getPort / start / stop idempotency
  // -------------------------------------------------------------------------

  it('getPort() returns null before start() is called', () => {
    listener = new WebhookListener({
      rules: [webhookRule('a', '/a')],
      bearerToken: 't',
      port: 0,
      dispatch: async () => undefined,
    });
    expect(listener.getPort()).toBeNull();
  });

  it('stop() is a no-op when server was never started', async () => {
    listener = new WebhookListener({
      rules: [webhookRule('a', '/a')],
      bearerToken: 't',
      port: 0,
      dispatch: async () => undefined,
    });
    await expect(listener.stop()).resolves.toBeUndefined();
  });

  it('start() is idempotent — calling it twice does not rebind', async () => {
    const port = await startListener([webhookRule('a', '/a')]);
    await listener!.start();
    expect(listener!.getPort()).toBe(port);
  });

  it('stop() twice — second call is a no-op', async () => {
    await startListener([webhookRule('a', '/a')]);
    await listener!.stop();
    await expect(listener!.stop()).resolves.toBeUndefined();
    expect(listener!.getPort()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // updateRules
  // -------------------------------------------------------------------------

  it('updateRules() changes routing at runtime', async () => {
    const port = await startListener([webhookRule('old', '/old-path')]);

    const before = await postTo(port, '/old-path', { token: 'secret-bearer' });
    expect(before.status).toBe(202);

    listener!.updateRules([webhookRule('new', '/new-path')]);

    const afterOld = await postTo(port, '/old-path', { token: 'secret-bearer' });
    expect(afterOld.status).toBe(404);

    const afterNew = await postTo(port, '/new-path', { token: 'secret-bearer' });
    expect(afterNew.status).toBe(202);
    expect(fires).toHaveLength(2);
    expect(fires[1].rule.name).toBe('new');
  });

  it('updateRules() throws on duplicate paths and leaves existing routes intact', async () => {
    await startListener([webhookRule('a', '/a')]);
    expect(() =>
      listener!.updateRules([webhookRule('x', '/hit'), webhookRule('y', '/hit')]),
    ).toThrow(/duplicate webhook path/);
    expect(listener!.listPaths()).toEqual(['/a']);
  });

  // -------------------------------------------------------------------------
  // Body size limits
  // -------------------------------------------------------------------------

  it('body larger than MAX_BODY_BYTES (16 KiB) → 413', async () => {
    const port = await startListener([webhookRule('big', '/big')]);
    const oversized = 'x'.repeat(16 * 1024 + 1);
    const res = await postTo(port, '/big', { token: 'secret-bearer', body: oversized });
    expect(res.status).toBe(413);
    expect(fires).toHaveLength(0);
  });

  it('server closes TCP connection after sending 413 for oversized body', async () => {
    const port = await startListener([webhookRule('big', '/big')]);
    const socketClosed = await new Promise<boolean>((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port });
      let got413 = false;
      sock.once('connect', () => {
        sock.write(
          'POST /big HTTP/1.1\r\n' +
          'Host: 127.0.0.1\r\n' +
          'Authorization: Bearer secret-bearer\r\n' +
          'Transfer-Encoding: chunked\r\n' +
          '\r\n',
        );
        const piece = 'x'.repeat(1024);
        for (let i = 0; i < 20; i++) {
          sock.write(`${piece.length.toString(16)}\r\n${piece}\r\n`);
        }
      });
      sock.on('data', (d: Buffer) => { if (d.toString().includes('413')) got413 = true; });
      sock.on('close', () => resolve(got413));
      sock.on('error', reject);
      setTimeout(() => reject(new Error('server did not close socket within 3s')), 3000);
    });
    expect(socketClosed).toBe(true);
  });

  it('body exactly at MAX_BODY_BYTES (16 KiB) is accepted → 202', async () => {
    const port = await startListener([webhookRule('big', '/big')]);
    const exact = 'x'.repeat(16 * 1024);
    const res = await postTo(port, '/big', { token: 'secret-bearer', body: exact });
    expect(res.status).toBe(202);
    expect(fires).toHaveLength(1);
    expect((fires[0].event.payload as { body: string }).body).toHaveLength(16 * 1024);
  });

  // -------------------------------------------------------------------------
  // Response contract and dispatch error handling
  // -------------------------------------------------------------------------

  it('202 response body is valid JSON { status: "accepted", path: "..." }', async () => {
    const port = await startListener([webhookRule('hook', '/my-hook')]);
    const res = await postTo(port, '/my-hook', { token: 'secret-bearer', body: 'data' });
    expect(res.status).toBe(202);
    const json = JSON.parse(res.body) as { status: string; path: string };
    expect(json.status).toBe('accepted');
    expect(json.path).toBe('/my-hook');
  });

  it('dispatch error is swallowed — 202 still returned to caller', async () => {
    listener = new WebhookListener({
      rules: [webhookRule('bomb', '/bomb')],
      bearerToken: 'secret-bearer',
      host: '127.0.0.1',
      port: 0,
      dispatch: async () => { throw new Error('dispatch exploded'); },
    });
    await listener.start();
    const port = listener.getPort();
    if (!port) throw new Error('listener did not bind a port');
    const res = await postTo(port, '/bomb', { token: 'secret-bearer', body: 'x' });
    expect(res.status).toBe(202);
  });
});
