import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { startReceiver, registerEventsCommand } from '../../src/commands/events.js';
import { runCli } from '../helpers/cli.js';

// ---------------------------------------------------------------------------
// Shared mock state for SwitchBotMqttClient — hoisted so the factory can use it
// ---------------------------------------------------------------------------
const mqttMock = vi.hoisted(() => ({
  messageHandler: null as ((topic: string, payload: Buffer) => void) | null,
  connectShouldFireMessage: false,
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
      onStateChange: vi.fn(() => () => {}),
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
    mqttMock.connectShouldFireMessage = false;
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
    const jsonLines = res.stdout.filter((l) => l.trim().startsWith('{'));
    expect(jsonLines).toHaveLength(1);
    const parsed = JSON.parse(jsonLines[0]) as { t: string; topic: string; payload: unknown };
    expect(parsed.topic).toBe('test/topic');
    expect(parsed.payload).toEqual({ state: 'on' });
    expect(typeof parsed.t).toBe('string');
  });

  it('wraps output in envelope with --json --max 1', async () => {
    mqttMock.connectShouldFireMessage = true;

    const res = await runCli(registerEventsCommand, ['--json', 'events', 'mqtt-tail', '--max', '1']);
    expect(res.exitCode).toBe(null);
    const jsonLines = res.stdout.filter((l) => l.trim().startsWith('{'));
    expect(jsonLines).toHaveLength(1);
    const parsed = JSON.parse(jsonLines[0]) as { schemaVersion: string; data: { topic: string } };
    expect(parsed.schemaVersion).toBe('1.1');
    expect(parsed.data.topic).toBe('test/topic');
  });

  it('exits 2 when --max is not a positive integer', async () => {
    const res = await runCli(registerEventsCommand, ['events', 'mqtt-tail', '--max', '0']);
    expect(res.exitCode).toBe(2);
  });
});
