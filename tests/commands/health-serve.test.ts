/**
 * Integration tests for `health serve` HTTP endpoints.
 * Uses createHealthHandler directly to avoid binding real ports during unit tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

// Mock the api/client module so getHealthReport doesn't need real config.
vi.mock('../../src/api/client.js', () => ({
  createClient: vi.fn(() => ({ get: vi.fn(), post: vi.fn() })),
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
  apiCircuitBreaker: {
    name: 'switchbot-api',
    getStats: vi.fn(() => ({ state: 'closed', failures: 0, lastOpenedAt: 0, nextProbeMs: 0 })),
    checkAndAllow: vi.fn(),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    reset: vi.fn(),
    getState: vi.fn(() => 'closed'),
  },
  CircuitOpenError: class CircuitOpenError extends Error {
    constructor(public readonly circuitName: string, public readonly nextAttemptMs: number) {
      super('circuit open');
      this.name = 'CircuitOpenError';
    }
  },
}));

import { createHealthHandler } from '../../src/commands/health.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function httpGet(port: number, path: string): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const { request } = require('node:http') as typeof import('node:http');
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf-8'),
        contentType: String(res.headers['content-type'] ?? ''),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const handler = createHealthHandler();
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') { reject(new Error('unexpected address')); return; }
      resolve({ server, port: addr.port });
    });
    server.on('error', reject);
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('health serve HTTP endpoints', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    const started = await startServer();
    server = started.server;
    port = started.port;
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('GET /healthz returns 200 with JSON body including overall and schemaVersion', async () => {
    const res = await httpGet(port, '/healthz');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('application/json');
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.schemaVersion).toBeDefined();
    const data = body.data as Record<string, unknown>;
    expect(['ok', 'degraded', 'down']).toContain(data.overall);
    expect(data.quota).toBeDefined();
    expect(data.circuit).toBeDefined();
    expect(data.process).toBeDefined();
  });

  it('GET /metrics returns 200 with Prometheus text', async () => {
    const res = await httpGet(port, '/metrics');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/plain');
    expect(res.body).toContain('switchbot_quota_used_total');
    expect(res.body).toContain('switchbot_circuit_open');
  });

  it('GET /unknown returns 404 with JSON error', async () => {
    const res = await httpGet(port, '/does-not-exist');
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.paths).toBeDefined();
  });
});
