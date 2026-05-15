import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { startIpcServer } from '../../src/daemon/server.js';
import { IpcDaemonClient, IpcDaemonClientError } from '../../src/daemon/client.js';
import { getDaemonSocketPath } from '../../src/daemon/socket-path.js';

function tempSocketPath(label: string): string {
  if (process.platform === 'win32') {
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    return `\\\\.\\pipe\\switchbot-test-${label}-${stamp}`;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ipc-'));
  return path.join(dir, `${label}.sock`);
}

describe('Daemon IPC: socket-path', () => {
  it('returns a platform-appropriate path', () => {
    const sp = getDaemonSocketPath();
    if (process.platform === 'win32') {
      expect(sp).toMatch(/^\\\\\.\\pipe\\switchbot-daemon-/);
    } else {
      expect(sp.endsWith('daemon.sock')).toBe(true);
    }
  });
});

describe('Daemon IPC: server + client', () => {
  let server: { close: () => Promise<void>; socketPath: string } | null = null;

  afterEach(async () => {
    if (server) await server.close();
    server = null;
  });

  it('responds to a basic JSON-RPC call with the registered handler', async () => {
    const socketPath = tempSocketPath('basic');
    server = await startIpcServer({
      socketPath,
      handlers: {
        'echo': (params) => ({ echoed: params }),
      },
    });

    const client = new IpcDaemonClient({ socketPath, timeoutMs: 2_000, connectTimeoutMs: 1_000 });
    const result = await client.call<{ echoed: unknown }>('echo', { hello: 'world' });
    expect(result).toEqual({ echoed: { hello: 'world' } });
  });

  it('returns an error response when the method is unknown', async () => {
    const socketPath = tempSocketPath('unknown');
    server = await startIpcServer({
      socketPath,
      handlers: { 'known': () => ({ ok: true }) },
    });

    const client = new IpcDaemonClient({ socketPath, timeoutMs: 2_000, connectTimeoutMs: 1_000 });
    await expect(client.call('does-not-exist')).rejects.toThrow(/Method not found/);
  });

  it('propagates handler errors as JSON-RPC error responses', async () => {
    const socketPath = tempSocketPath('handler-error');
    server = await startIpcServer({
      socketPath,
      handlers: {
        'boom': () => { throw new Error('handler exploded'); },
      },
    });

    const client = new IpcDaemonClient({ socketPath, timeoutMs: 2_000, connectTimeoutMs: 1_000 });
    try {
      await client.call('boom');
      expect.fail('Expected boom to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IpcDaemonClientError);
      expect((err as IpcDaemonClientError).message).toContain('handler exploded');
    }
  });

  it('handles concurrent calls without crossing responses', async () => {
    const socketPath = tempSocketPath('concurrent');
    server = await startIpcServer({
      socketPath,
      handlers: {
        'add': async (params) => {
          const p = params as { a: number; b: number };
          await new Promise((r) => setTimeout(r, 10));
          return { sum: p.a + p.b };
        },
      },
    });

    const client = new IpcDaemonClient({ socketPath, timeoutMs: 2_000, connectTimeoutMs: 1_000 });
    const results = await Promise.all([
      client.call<{ sum: number }>('add', { a: 1, b: 2 }),
      client.call<{ sum: number }>('add', { a: 10, b: 20 }),
      client.call<{ sum: number }>('add', { a: 100, b: 200 }),
    ]);
    expect(results.map((r) => r.sum)).toEqual([3, 30, 300]);
  });

  it('async handler results round-trip', async () => {
    const socketPath = tempSocketPath('async');
    server = await startIpcServer({
      socketPath,
      handlers: {
        'slow-status': async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { status: 'running', rulesActive: 7 };
        },
      },
    });

    const client = new IpcDaemonClient({ socketPath, timeoutMs: 2_000, connectTimeoutMs: 1_000 });
    const result = await client.call<{ status: string; rulesActive: number }>('slow-status');
    expect(result).toEqual({ status: 'running', rulesActive: 7 });
  });

  it('throws a recognizable error when the daemon is not listening', async () => {
    const bogusPath = tempSocketPath('bogus-not-listening');
    const client = new IpcDaemonClient({ socketPath: bogusPath, timeoutMs: 1_500, connectTimeoutMs: 1_000 });
    await expect(client.call('daemon.status')).rejects.toThrow(/IPC daemon not listening|IPC connect timed out|IPC socket error/);
  });

  it('rejects malformed (non-JSON) lines with a parse error response', async () => {
    const socketPath = tempSocketPath('malformed');
    server = await startIpcServer({
      socketPath,
      handlers: { 'noop': () => ({}) },
    });

    // Manually open a socket and send malformed data — we shouldn't crash.
    const net = await import('node:net');
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      let buffer = '';
      sock.on('connect', () => {
        sock.write('not-json\n');
      });
      sock.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        if (buffer.includes('\n')) {
          try {
            const response = JSON.parse(buffer.trim());
            expect(response.error.code).toBe(-32700);
            sock.end();
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      });
      sock.on('error', reject);
    });
  });

  it('client.ping() resolves with latency when daemon.status is registered', async () => {
    const socketPath = tempSocketPath('ping');
    server = await startIpcServer({
      socketPath,
      handlers: {
        'daemon.status': () => ({ status: 'running', rulesActive: 2 }),
      },
    });

    const client = new IpcDaemonClient({ socketPath, timeoutMs: 2_000, connectTimeoutMs: 1_000 });
    const result = await client.ping();
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.status).toEqual({ status: 'running', rulesActive: 2 });
  });

  it('isListening() reports true after start, false after close', async () => {
    const socketPath = tempSocketPath('listening');
    const handle = await startIpcServer({ socketPath, handlers: { 'noop': () => ({}) } });
    server = handle;
    expect(handle.isListening()).toBe(true);
    await handle.close();
    server = null;
    expect(handle.isListening()).toBe(false);
  });
});
