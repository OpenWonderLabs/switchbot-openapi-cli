import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
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
});
