import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { startReceiver } from '../../src/commands/events.js';

async function postJson(port: number, path: string, body: unknown): Promise<number> {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function pickPort(): Promise<number> {
  const srv = http.createServer();
  srv.listen(0);
  await once(srv, 'listening');
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe('events tail receiver', () => {
  it('accepts POST and forwards parsed JSON body to the callback', async () => {
    const port = await pickPort();
    const received: unknown[] = [];
    const server = startReceiver(port, '/', null, (ev) => received.push(ev));

    const status = await postJson(port, '/', { event: 'state-change', deviceId: 'BOT1' });
    expect(status).toBe(204);

    await new Promise<void>((r) => server.close(() => r()));

    expect(received).toHaveLength(1);
    const ev = received[0] as { path: string; matched: boolean; body: { event: string; deviceId: string } };
    expect(ev.path).toBe('/');
    expect(ev.matched).toBe(true);
    expect(ev.body).toEqual({ event: 'state-change', deviceId: 'BOT1' });
  });

  it('returns 405 for non-POST methods', async () => {
    const port = await pickPort();
    const server = startReceiver(port, '/', null, () => {});
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/', method: 'GET' },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
    await new Promise<void>((r) => server.close(() => r()));
    expect(status).toBe(405);
  });

  it('returns 404 for mismatched paths', async () => {
    const port = await pickPort();
    const server = startReceiver(port, '/webhook', null, () => {});
    const status = await postJson(port, '/other', {});
    await new Promise<void>((r) => server.close(() => r()));
    expect(status).toBe(404);
  });

  it('accepts any path when matcher is "*"', async () => {
    const port = await pickPort();
    const received: unknown[] = [];
    const server = startReceiver(port, '*', null, (ev) => received.push(ev));
    await postJson(port, '/any/path/here', { hello: 'world' });
    await new Promise<void>((r) => server.close(() => r()));
    expect(received).toHaveLength(1);
  });

  it('keeps body as raw string when JSON parsing fails', async () => {
    const port = await pickPort();
    const received: Array<{ body: unknown }> = [];
    const server = startReceiver(port, '/', null, (ev) => received.push(ev as { body: unknown }));
    await postJson(port, '/', '{not json');
    await new Promise<void>((r) => server.close(() => r()));
    expect(received[0].body).toBe('{not json');
  });

  it('marks events as unmatched when deviceId filter does not match', async () => {
    const port = await pickPort();
    const received: Array<{ matched: boolean }> = [];
    const server = startReceiver(
      port,
      '/',
      { deviceId: 'BOT1' },
      (ev) => received.push(ev as { matched: boolean }),
    );
    await postJson(port, '/', { context: { deviceMac: 'BOT2', deviceType: 'Bot' } });
    await postJson(port, '/', { context: { deviceMac: 'BOT1', deviceType: 'Bot' } });
    await new Promise<void>((r) => server.close(() => r()));
    expect(received).toHaveLength(2);
    expect(received[0].matched).toBe(false);
    expect(received[1].matched).toBe(true);
  });

  it('type filter matches on context.deviceType', async () => {
    const port = await pickPort();
    const received: Array<{ matched: boolean }> = [];
    const server = startReceiver(
      port,
      '/',
      { type: 'WoMeter' },
      (ev) => received.push(ev as { matched: boolean }),
    );
    await postJson(port, '/', { context: { deviceMac: 'X1', deviceType: 'Bot' } });
    await postJson(port, '/', { context: { deviceMac: 'X2', deviceType: 'WoMeter' } });
    await new Promise<void>((r) => server.close(() => r()));
    expect(received[0].matched).toBe(false);
    expect(received[1].matched).toBe(true);
  });

  it('rejects oversized bodies with 413', async () => {
    const port = await pickPort();
    const server = startReceiver(port, '/', null, () => {});
    const big = 'x'.repeat(2_000_000);
    const status = await new Promise<number>((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(big),
          },
        },
        (res) => {
          res.resume();
          const code = res.statusCode ?? 0;
          res.on('end', () => resolve(code));
          res.on('close', () => resolve(code));
        },
      );
      // Server may RST the socket after writing 413; swallow and resolve via
      // the response we already captured.
      req.on('error', () => resolve(0));
      req.write(big, () => req.end());
    });
    await new Promise<void>((r) => server.close(() => r()));
    expect(status).toBe(413);
  });
});
