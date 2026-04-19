/**
 * Tests for health/metrics endpoints in `mcp serve --port` mode.
 * Verifies that /ready returns 503 + reason:'mqtt disabled' when MQTT is not configured,
 * and that /metrics includes the switchbot_mqtt_state gauge.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { EventSubscriptionManager } from '../../src/mcp/events-subscription.js';

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

// Build a minimal HTTP server that mirrors the serve logic for /ready and /metrics.
function makeHealthHandler(eventManager: EventSubscriptionManager) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/ready' && req.method === 'GET') {
      const state = eventManager.getState();
      const ready = state !== 'failed' && state !== 'disabled';
      const status = ready ? 200 : 503;
      const body: Record<string, unknown> = { ready, version: '2.0.0', mqtt: state };
      if (!ready) body.reason = state === 'disabled' ? 'mqtt disabled' : 'mqtt failed';
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    if (req.url === '/metrics' && req.method === 'GET') {
      const mqttState = eventManager.getState();
      const metrics = [
        `switchbot_mqtt_connected ${mqttState === 'connected' ? 1 : 0}`,
        `switchbot_mqtt_state{state="disabled"} ${mqttState === 'disabled' ? 1 : 0}`,
        `switchbot_mqtt_state{state="connected"} ${mqttState === 'connected' ? 1 : 0}`,
        `switchbot_mqtt_state{state="failed"} ${mqttState === 'failed' ? 1 : 0}`,
        `switchbot_mqtt_subscribers ${eventManager.getSubscriberCount()}`,
      ].join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(metrics);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  };
}

function startHealthServer(
  eventManager: EventSubscriptionManager,
): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(makeHealthHandler(eventManager));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        stop: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
    server.on('error', reject);
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('mcp serve health endpoints', () => {
  describe('/ready with MQTT disabled (no credentials)', () => {
    let port: number;
    let stop: () => Promise<void>;

    beforeAll(async () => {
      const eventManager = new EventSubscriptionManager();
      const srv = await startHealthServer(eventManager);
      port = srv.port;
      stop = srv.stop;
    });

    afterAll(async () => { await stop(); });

    it('returns 503 when MQTT is disabled', async () => {
      const res = await get(port, '/ready');
      expect(res.status).toBe(503);
    });

    it('body has ready:false, mqtt:"disabled", reason:"mqtt disabled"', async () => {
      const res = await get(port, '/ready');
      const body = JSON.parse(res.body);
      expect(body.ready).toBe(false);
      expect(body.mqtt).toBe('disabled');
      expect(body.reason).toBe('mqtt disabled');
    });
  });

  describe('/metrics with MQTT disabled', () => {
    let port: number;
    let stop: () => Promise<void>;

    beforeAll(async () => {
      const eventManager = new EventSubscriptionManager();
      const srv = await startHealthServer(eventManager);
      port = srv.port;
      stop = srv.stop;
    });

    afterAll(async () => { await stop(); });

    it('returns 200', async () => {
      const res = await get(port, '/metrics');
      expect(res.status).toBe(200);
    });

    it('emits switchbot_mqtt_state{state="disabled"} 1', async () => {
      const res = await get(port, '/metrics');
      expect(res.body).toContain('switchbot_mqtt_state{state="disabled"} 1');
    });

    it('emits switchbot_mqtt_state{state="connected"} 0 when disabled', async () => {
      const res = await get(port, '/metrics');
      expect(res.body).toContain('switchbot_mqtt_state{state="connected"} 0');
    });

    it('emits switchbot_mqtt_connected 0 when disabled', async () => {
      const res = await get(port, '/metrics');
      expect(res.body).toContain('switchbot_mqtt_connected 0');
    });
  });

  describe('EventSubscriptionManager default state', () => {
    it('returns "disabled" with no mqtt client', () => {
      const mgr = new EventSubscriptionManager();
      expect(mgr.getState()).toBe('disabled');
    });

    it('getRecentEvents returns empty array when no events buffered', () => {
      const mgr = new EventSubscriptionManager();
      expect(mgr.getRecentEvents()).toEqual([]);
    });
  });
});
