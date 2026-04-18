/**
 * Integration tests for `mcp serve --port` (HTTP transport).
 *
 * These tests start a real HTTP server on a random port and exercise
 * the StreamableHTTP transport directly — covering successful round-trips,
 * malformed input, sequential stateless requests, and the res.on('close')
 * cleanup path.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// ---------------------------------------------------------------------------
// Mocks (same setup as mcp.test.ts so createSwitchBotMcpServer doesn't call
// real API endpoints during protocol-level tests).
// ---------------------------------------------------------------------------
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
}));

import { createSwitchBotMcpServer } from '../../src/commands/mcp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replicates the exact handler used by `mcp serve --port`. */
function makeHandler() {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reqTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const reqServer = createSwitchBotMcpServer();
    res.on('close', () => {
      reqTransport.close();
      reqServer.close();
    });
    try {
      await reqServer.connect(reqTransport);
      await reqTransport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
      }
    }
  };
}

function startServer(): Promise<{ server: Server; port: number; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(makeHandler());
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        port: addr.port,
        stop: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
    server.on('error', reject);
  });
}

/** POST to /mcp and collect the full response body. */
function post(port: number, bodyStr: string): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          Accept: 'application/json, text/event-stream',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, contentType: res.headers['content-type'] ?? '', body: data }),
        );
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Parse a JSON-RPC response from either a direct JSON body or an SSE stream.
 * Returns null when the body is empty or contains no data frame.
 */
function parseRpc(body: string, contentType: string): unknown {
  if (contentType.includes('text/event-stream')) {
    const dataLine = body.split('\n').find((l) => l.startsWith('data: '));
    if (!dataLine) return null;
    return JSON.parse(dataLine.slice('data: '.length));
  }
  return body ? JSON.parse(body) : null;
}

const INIT_MSG = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.1' },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mcp serve --port (HTTP transport)', () => {
  let port: number;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const srv = await startServer();
    port = srv.port;
    stop = srv.stop;
  });

  afterAll(async () => {
    await stop();
  });

  it('returns 200 and a valid MCP initialize result', async () => {
    const resp = await post(port, JSON.stringify(INIT_MSG));
    expect(resp.status).toBe(200);
    const rpc = parseRpc(resp.body, resp.contentType) as { jsonrpc: string; id: number; result: { serverInfo: { name: string } } } | null;
    expect(rpc).not.toBeNull();
    expect(rpc!.jsonrpc).toBe('2.0');
    expect(rpc!.id).toBe(1);
    expect(rpc!.result.serverInfo.name).toBe('switchbot');
  });

  it('returns an error status (4xx/5xx) for malformed JSON', async () => {
    const resp = await post(port, 'NOT VALID JSON {{{');
    expect(resp.status).toBeGreaterThanOrEqual(400);
  });

  it('handles multiple sequential requests independently (stateless)', async () => {
    const r1 = await post(port, JSON.stringify({ ...INIT_MSG, id: 10 }));
    const r2 = await post(port, JSON.stringify({ ...INIT_MSG, id: 20 }));

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const rpc1 = parseRpc(r1.body, r1.contentType) as { id: number } | null;
    const rpc2 = parseRpc(r2.body, r2.contentType) as { id: number } | null;
    // Each request gets back its own id — no state bleed from request 1 to 2.
    expect(rpc1!.id).toBe(10);
    expect(rpc2!.id).toBe(20);
  });

  it('calls transport.close() after connection closes (no resource leak)', async () => {
    const closeSpy = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close');

    await post(port, JSON.stringify(INIT_MSG));
    // Wait for the res 'close' event to propagate after the HTTP response ends.
    await vi.waitFor(() => {
      expect(closeSpy).toHaveBeenCalled();
    }, { timeout: 1000 });

    closeSpy.mockRestore();
  });

  it('calls transport.close() even when handleRequest throws (error-path cleanup)', async () => {
    const closeSpy = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close');

    // Malformed JSON causes an immediate error response (connection closes after the 4xx).
    await post(port, 'NOT VALID JSON {{{');

    // res.on('close') fires after the response ends — wait for the spy.
    await vi.waitFor(() => {
      expect(closeSpy).toHaveBeenCalled();
    }, { timeout: 2000 });

    closeSpy.mockRestore();
  });
});
