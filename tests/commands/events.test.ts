import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { startReceiver, registerEventsCommand } from '../../src/commands/events.js';
import type { FilterClause } from '../../src/utils/filter.js';
import { deviceHistoryStore } from '../../src/mcp/device-history.js';
import { runCli } from '../helpers/cli.js';

// ---------------------------------------------------------------------------
// Shared mock state for SwitchBotMqttClient — hoisted so the factory can use it
// ---------------------------------------------------------------------------
const mqttMock = vi.hoisted(() => ({
  messageHandler: null as ((topic: string, payload: Buffer) => void) | null,
  stateHandler: null as ((state: string) => void) | null,
  connectShouldFireMessage: false,
  connectShouldFireState: null as string | null,
  instance: null as {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    onMessage: ReturnType<typeof vi.fn>;
  } | null,
}));

vi.mock('../../src/mqtt/client.js', () => {
  const MockSwitchBotMqttClient = vi.fn(function (this: unknown) {
    const inst = {
      connect: vi.fn(async () => {
        // State fires first (matches real MQTT: connection completes, then
        // messages arrive). Both are scheduled with setTimeout(0) so they
        // land in order on the microtask queue.
        if (mqttMock.connectShouldFireState) {
          const state = mqttMock.connectShouldFireState;
          setTimeout(() => {
            if (mqttMock.stateHandler) mqttMock.stateHandler(state);
          }, 0);
        }
        if (mqttMock.connectShouldFireMessage) {
          setTimeout(() => {
            if (mqttMock.messageHandler) {
              mqttMock.messageHandler('test/topic', Buffer.from(JSON.stringify({ state: 'on' })));
            }
          }, 0);
        }
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      onMessage: vi.fn((handler: (topic: string, payload: Buffer) => void) => {
        mqttMock.messageHandler = handler;
        return () => { mqttMock.messageHandler = null; };
      }),
      onStateChange: vi.fn((handler: (state: string) => void) => {
        mqttMock.stateHandler = handler;
        return () => { mqttMock.stateHandler = null; };
      }),
    };
    mqttMock.instance = inst;
    return inst;
  });
  return { SwitchBotMqttClient: MockSwitchBotMqttClient };
});

vi.mock('../../src/mqtt/credential.js', () => ({
  fetchMqttCredential: vi.fn().mockResolvedValue({
    brokerUrl: 'mqtts://broker.test:8883',
    region: 'us-east-1',
    clientId: 'test-client-id',
    topics: { status: '$aws/things/+/shadow/update/accepted' },
    qos: 0,
    tls: { enabled: true, caBase64: 'Y2E=', certBase64: 'Y2VydA==', keyBase64: 'a2V5' },
  }),
}));

vi.mock('../../src/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({ token: 'test-token', secret: 'test-secret' }),
  tryLoadConfig: vi.fn().mockReturnValue({ token: 'test-token', secret: 'test-secret' }),
}));

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
    const filter: FilterClause[] = [{ key: 'deviceId', op: 'eq', raw: 'BOT1' }];
    const server = startReceiver(
      port,
      '/',
      filter,
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
    const filter: FilterClause[] = [{ key: 'type', op: 'eq', raw: 'WoMeter' }];
    const server = startReceiver(
      port,
      '/',
      filter,
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

  it('P6: unified envelope carries schemaVersion / source / kind / payload / topic on webhook events', async () => {
    const port = await pickPort();
    const received: unknown[] = [];
    const server = startReceiver(port, '/', null, (ev) => received.push(ev));
    await postJson(port, '/', {
      eventType: 'state-change',
      context: { deviceMac: 'BOT-7', deviceType: 'Bot', eventId: 'evt-1' },
    });
    await new Promise<void>((r) => server.close(() => r()));
    const ev = received[0] as {
      schemaVersion: string;
      source: string;
      kind: string;
      topic: string;
      payload: unknown;
      eventId: string | null;
      deviceId: string | null;
      matchedKeys: string[];
      // legacy:
      body: unknown;
      path: string;
      matched: boolean;
    };
    expect(ev.schemaVersion).toBe('1');
    expect(ev.source).toBe('webhook');
    expect(ev.kind).toBe('event');
    expect(ev.topic).toBe('/');
    expect(ev.eventId).toBe('evt-1');
    expect(ev.deviceId).toBe('BOT-7');
    expect(ev.matchedKeys).toEqual([]);
    // legacy mirror still present:
    expect(ev.path).toBe('/');
    expect(ev.body).toEqual(ev.payload);
    expect(ev.matched).toBe(true);
  });

  it('P6: matchedKeys lists which filter clauses hit on webhook events', async () => {
    const port = await pickPort();
    const received: Array<{ matched: boolean; matchedKeys: string[] }> = [];
    const filter: FilterClause[] = [
      { key: 'deviceId', op: 'eq', raw: 'BOT1' },
      { key: 'type', op: 'eq', raw: 'Bot' },
    ];
    const server = startReceiver(
      port,
      '/',
      filter,
      (ev) => received.push(ev as { matched: boolean; matchedKeys: string[] }),
    );
    await postJson(port, '/', { context: { deviceMac: 'BOT1', deviceType: 'Bot' } });
    await postJson(port, '/', { context: { deviceMac: 'BOT2', deviceType: 'Bot' } });
    await new Promise<void>((r) => server.close(() => r()));
    expect(received[0].matched).toBe(true);
    expect(received[0].matchedKeys).toEqual(['deviceId', 'type']);
    expect(received[1].matched).toBe(false);
    expect(received[1].matchedKeys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mqtt-tail subcommand tests
// ---------------------------------------------------------------------------
import { fetchMqttCredential } from '../../src/mqtt/credential.js';
import { tryLoadConfig } from '../../src/config.js';

const mockCredential = {
  brokerUrl: 'mqtts://broker.test:8883',
  region: 'us-east-1',
  clientId: 'test-client-id',
  topics: { status: '$aws/things/+/shadow/update/accepted' },
  qos: 0,
  tls: { enabled: true, caBase64: 'Y2E=', certBase64: 'Y2VydA==', keyBase64: 'a2V5' },
};

describe('events mqtt-tail', () => {
  beforeEach(() => {
    mqttMock.messageHandler = null;
    mqttMock.stateHandler = null;
    mqttMock.connectShouldFireMessage = false;
    mqttMock.connectShouldFireState = null;
    vi.mocked(fetchMqttCredential).mockResolvedValue(mockCredential);
    vi.mocked(tryLoadConfig).mockReturnValue({ token: 'test-token', secret: 'test-secret' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exits 2 with UsageError when no credentials are configured', async () => {
    vi.mocked(tryLoadConfig).mockReturnValue(null);
    const res = await runCli(registerEventsCommand, ['events', 'mqtt-tail']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.some((l) => l.includes('credentials'))).toBe(true);
  });

  it('outputs JSONL and stops after --max 1', async () => {
    mqttMock.connectShouldFireMessage = true;

    const res = await runCli(registerEventsCommand, ['events', 'mqtt-tail', '--max', '1']);
    expect(res.exitCode).toBe(null);
    const jsonLines = res.stdout
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l) as { type?: string; topic?: string; payload?: unknown; t?: string });
    const events = jsonLines.filter((j) => typeof j.type !== 'string' || !j.type.startsWith('__'));
    expect(events).toHaveLength(1);
    const parsed = events[0] as { t: string; topic: string; payload: unknown };
    expect(parsed.topic).toBe('test/topic');
    expect(parsed.payload).toEqual({ state: 'on' });
    expect(typeof parsed.t).toBe('string');
  });

  it('wraps output in envelope with --json --max 1', async () => {
    mqttMock.connectShouldFireMessage = true;

    const res = await runCli(registerEventsCommand, ['--json', 'events', 'mqtt-tail', '--max', '1']);
    expect(res.exitCode).toBe(null);
    const jsonLines = res.stdout
      .filter((l) => l.trim().startsWith('{'))
      .map(
        (l) =>
          JSON.parse(l) as {
            stream?: boolean;
            schemaVersion?: string;
            data?: { type?: string; topic?: string };
          },
      );
    // P7: skip the stream header; __session_start also excluded via its type prefix.
    const events = jsonLines.filter(
      (j) =>
        j.stream !== true &&
        (typeof j.data?.type !== 'string' || !j.data.type.startsWith('__')),
    );
    expect(events).toHaveLength(1);
    expect(events[0].schemaVersion).toBe('1.1');
    expect(events[0].data!.payloadVersion).toBe('1');
    expect(events[0].data!.topic).toBe('test/topic');
  });

  it('exits 2 when --max is not a positive integer', async () => {
    const res = await runCli(registerEventsCommand, ['events', 'mqtt-tail', '--max', '0']);
    expect(res.exitCode).toBe(2);
  });

  it('exits 2 when --max swallows "--help" (token-swallow regression)', async () => {
    const res = await runCli(registerEventsCommand, ['events', 'mqtt-tail', '--max', '--help']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toMatch(/--max.*numeric value/i);
  });

  it('exits 1 and stops cleanly when MQTT state transitions to "failed"', async () => {
    // Simulates the real-world scenario where the MQTT credential expires and
    // reconnect exhausts — the loop previously hung until Node killed it with
    // exit code 13 (unsettled top-level await). Now it aborts and exits 1.
    mqttMock.connectShouldFireState = 'failed';
    const res = await runCli(registerEventsCommand, ['events', 'mqtt-tail']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr.join('\n')).toMatch(/failed permanently|credential expired|reconnect exhausted/i);
  });

  it('emits __connect control record on initial connect + eventId on messages (C2)', async () => {
    mqttMock.connectShouldFireMessage = true;
    mqttMock.connectShouldFireState = 'connected';

    const res = await runCli(registerEventsCommand, ['events', 'mqtt-tail', '--max', '1']);
    const jsonLines = res.stdout.filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
    // Expect at least a control record (__connect) + one real event.
    const control = jsonLines.find((j) => typeof (j as { type?: unknown }).type === 'string' && (j as { type: string }).type.startsWith('__'));
    expect(control).toBeDefined();
    expect((control as { type: string }).type).toBe('__connect');
    expect(typeof (control as { eventId: string }).eventId).toBe('string');

    const real = jsonLines.find((j) => (j as { topic?: string }).topic === 'test/topic');
    expect(real).toBeDefined();
    expect(typeof (real as { eventId: string }).eventId).toBe('string');
    // UUID v4 shape, not the control UUID.
    expect((real as { eventId: string }).eventId).not.toBe((control as { eventId: string }).eventId);
  });

  it('emits __disconnect control record when state transitions to failed (C2)', async () => {
    mqttMock.connectShouldFireState = 'failed';
    const res = await runCli(registerEventsCommand, ['events', 'mqtt-tail']);
    const jsonLines = res.stdout.filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
    const disconnect = jsonLines.find((j) => (j as { type?: string }).type === '__disconnect');
    expect(disconnect).toBeDefined();
  });

  it('emits __session_start envelope under --json before broker connect (bug #56)', async () => {
    mqttMock.connectShouldFireMessage = true;
    const res = await runCli(registerEventsCommand, ['--json', 'events', 'mqtt-tail', '--max', '1']);
    const jsonLines = res.stdout
      .filter((l) => l.trim().startsWith('{'))
      .map(
        (l) =>
          JSON.parse(l) as {
            stream?: boolean;
            eventKind?: string;
            cadence?: string;
            data?: { payloadVersion?: string; type?: string; state?: string; at?: string; eventId?: string };
          },
      );
    const sessionStart = jsonLines.find((j) => j.data?.type === '__session_start');
    expect(sessionStart).toBeDefined();
    expect(sessionStart!.data!.payloadVersion).toBe('1');
    expect(sessionStart!.data!.state).toBe('connecting');
    expect(typeof sessionStart!.data!.at).toBe('string');
    expect(typeof sessionStart!.data!.eventId).toBe('string');
    // P7: the very first JSON line under --json is the stream header;
    // __session_start is now the second line but still precedes any
    // broker activity so consumers still learn we're "connecting".
    expect(jsonLines[0].stream).toBe(true);
    expect(jsonLines[0].eventKind).toBe('event');
    expect(jsonLines[0].cadence).toBe('push');
    expect(jsonLines[1].data?.type).toBe('__session_start');
  });

  it('P6: mqtt event record carries unified envelope (source/kind/schemaVersion/deviceId)', async () => {
    mqttMock.connectShouldFireMessage = true;

    const res = await runCli(registerEventsCommand, ['events', 'mqtt-tail', '--max', '1']);
    expect(res.exitCode).toBe(null);
    const jsonLines = res.stdout
      .filter((l) => l.trim().startsWith('{'))
      .map(
        (l) =>
          JSON.parse(l) as {
            type?: string;
            source?: string;
            kind?: string;
            schemaVersion?: string;
            topic?: string;
            payload?: unknown;
            deviceId?: string | null;
          },
      );
    const event = jsonLines.find((j) => j.kind === 'event');
    expect(event).toBeDefined();
    expect(event!.schemaVersion).toBe('1');
    expect(event!.source).toBe('mqtt');
    expect(event!.kind).toBe('event');
    expect(event!.topic).toBe('test/topic');
    expect(event!.payload).toEqual({ state: 'on' });
    // deviceId is nullable on records without context — present as `null`
    expect(event).toHaveProperty('deviceId');
  });

  it('P6: mqtt control records carry unified envelope alongside legacy type', async () => {
    mqttMock.connectShouldFireState = 'failed';
    const res = await runCli(registerEventsCommand, ['events', 'mqtt-tail']);
    const jsonLines = res.stdout
      .filter((l) => l.trim().startsWith('{'))
      .map(
        (l) =>
          JSON.parse(l) as {
            type?: string;
            kind?: string;
            source?: string;
            schemaVersion?: string;
            controlKind?: string;
            at?: string;
            t?: string;
          },
      );
    const disconnect = jsonLines.find((j) => j.type === '__disconnect');
    expect(disconnect).toBeDefined();
    expect(disconnect!.kind).toBe('control');
    expect(disconnect!.source).toBe('mqtt');
    expect(disconnect!.schemaVersion).toBe('1');
    expect(disconnect!.controlKind).toBe('disconnect');
    // Legacy field `at` mirrors the unified `t`.
    expect(disconnect!.at).toBe(disconnect!.t);
  });

  it('P7: mqtt-tail emits a streaming JSON header as the first JSON line under --json', async () => {
    mqttMock.connectShouldFireMessage = true;
    const res = await runCli(registerEventsCommand, ['--json', 'events', 'mqtt-tail', '--max', '1']);
    const firstJson = res.stdout.find((l) => l.trim().startsWith('{'));
    expect(firstJson).toBeDefined();
    const header = JSON.parse(firstJson!) as {
      schemaVersion: string;
      stream: boolean;
      eventKind: string;
      cadence: string;
    };
    expect(header.schemaVersion).toBe('1.1');
    expect(header.stream).toBe(true);
    expect(header.eventKind).toBe('event');
    expect(header.cadence).toBe('push');
  });
});

// ---------------------------------------------------------------------------
// __control.jsonl persistence tests (bug #10)
// ---------------------------------------------------------------------------
describe('events mqtt-tail — control event persistence', () => {
  let tmpHome: string;

  beforeEach(() => {
    mqttMock.messageHandler = null;
    mqttMock.stateHandler = null;
    mqttMock.connectShouldFireMessage = false;
    mqttMock.connectShouldFireState = null;
    vi.mocked(fetchMqttCredential).mockResolvedValue(mockCredential);
    vi.mocked(tryLoadConfig).mockReturnValue({ token: 'test-token', secret: 'test-secret' });

    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcli-ctlevt-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    deviceHistoryStore.resetSizes();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it('writes __control.jsonl with __connect event on initial connect', async () => {
    mqttMock.connectShouldFireMessage = true;
    mqttMock.connectShouldFireState = 'connected';

    await runCli(registerEventsCommand, ['events', 'mqtt-tail', '--max', '1']);

    const controlFile = path.join(tmpHome, '.switchbot', 'device-history', '__control.jsonl');
    expect(fs.existsSync(controlFile)).toBe(true);

    const lines = fs.readFileSync(controlFile, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const parsed = JSON.parse(lines[0]) as { type: string; at: string; eventId: string };
    expect(parsed.type).toBe('__connect');
    expect(typeof parsed.at).toBe('string');
    expect(typeof parsed.eventId).toBe('string');
  });

  it('writes __disconnect to __control.jsonl on failed state', async () => {
    mqttMock.connectShouldFireState = 'failed';

    await runCli(registerEventsCommand, ['events', 'mqtt-tail']);

    const controlFile = path.join(tmpHome, '.switchbot', 'device-history', '__control.jsonl');
    expect(fs.existsSync(controlFile)).toBe(true);

    const lines = fs.readFileSync(controlFile, 'utf-8').trim().split('\n').filter(Boolean);
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toContain('__disconnect');
  });

  it('does not write per-device files for control events (no cross-contamination)', async () => {
    // Use 'failed' so the command exits cleanly without needing --max or a device message.
    mqttMock.connectShouldFireState = 'failed';

    await runCli(registerEventsCommand, ['events', 'mqtt-tail']);

    const histDir = path.join(tmpHome, '.switchbot', 'device-history');
    if (!fs.existsSync(histDir)) return; // no dir means no per-device files — pass

    const files = fs.readdirSync(histDir);
    // Only __control.jsonl should exist; no per-device .json or .jsonl for a real deviceId
    const deviceFiles = files.filter((f) => !f.startsWith('__'));
    expect(deviceFiles).toHaveLength(0);
  });
});
