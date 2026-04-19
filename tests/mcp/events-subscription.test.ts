import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DeviceShadowEvent } from '../../src/mqtt/types.js';

// --- Mock MqttTlsClient: emits 'message' events on demand. --------------------
const fakeMqtt = vi.hoisted(() => {
  // EventEmitter is a builtin so it's safe to require inside the hoist factory.
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  type Listener = (topic: string, payload: Buffer) => void;
  const emitter = new EventEmitter();
  const end = vi.fn(async () => { emitter.removeAllListeners('message'); });
  const connect = vi.fn(async () => {});

  class MqttTlsClientMock {
    on(event: string, handler: Listener) { emitter.on(event, handler); }
    async connect() { await connect(); }
    async end() { await end(); }
  }

  return {
    emitter,
    end,
    connect,
    MqttTlsClientMock,
    emitMessage: (obj: unknown) => {
      emitter.emit('message', 'topic/x', Buffer.from(JSON.stringify(obj)));
    },
    reset: () => {
      emitter.removeAllListeners('message');
      end.mockClear();
      connect.mockClear();
    },
  };
});

vi.mock('../../src/mqtt/client.js', () => ({
  MqttTlsClient: fakeMqtt.MqttTlsClientMock,
}));

vi.mock('../../src/mqtt/credential.js', () => ({
  getCredential: vi.fn(async () => ({
    brokerUrl: 'mqtts://fake',
    clientId: 'fake',
    topics: ['fake'],
    tls: { caBase64: '', certBase64: '', keyBase64: '' },
    qos: 1,
    expiresAt: Date.now() + 60_000,
  })),
}));

vi.mock('../../src/config.js', () => ({
  loadConfig: vi.fn(() => ({ token: 't', secret: 's' })),
}));

vi.mock('../../src/devices/cache.js', () => ({
  setCachedStatus: vi.fn(),
  loadStatusCache: vi.fn(() => ({ entries: {} })),
}));

let EventSubscriptionManager: typeof import('../../src/mcp/events-subscription.js').EventSubscriptionManager;

beforeEach(async () => {
  fakeMqtt.reset();
  ({ EventSubscriptionManager } = await import('../../src/mcp/events-subscription.js'));
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeShadow(deviceId: string, payloadExtra: Record<string, unknown> = {}) {
  return {
    clientId: deviceId,
    state: { deviceType: 'Bot', power: 'on', ...payloadExtra },
  };
}

describe('EventSubscriptionManager', () => {
  it('starts MQTT on first subscribe and tears down on last unsubscribe', async () => {
    const mgr = new EventSubscriptionManager();
    const unsub = await mgr.subscribe(() => {});
    expect(fakeMqtt.connect).toHaveBeenCalledTimes(1);
    await unsub();
    expect(fakeMqtt.end).toHaveBeenCalledTimes(1);
  });

  it('shares one MQTT client across multiple subscribers (ref-counted)', async () => {
    const mgr = new EventSubscriptionManager();
    const unsub1 = await mgr.subscribe(() => {});
    const unsub2 = await mgr.subscribe(() => {});
    expect(fakeMqtt.connect).toHaveBeenCalledTimes(1);
    await unsub1();
    expect(fakeMqtt.end).not.toHaveBeenCalled();
    await unsub2();
    expect(fakeMqtt.end).toHaveBeenCalledTimes(1);
  });

  it('fans out each shadow event to every active handler', async () => {
    const mgr = new EventSubscriptionManager();
    const calls1: DeviceShadowEvent[] = [];
    const calls2: DeviceShadowEvent[] = [];
    await mgr.subscribe((e) => calls1.push(e));
    await mgr.subscribe((e) => calls2.push(e));

    fakeMqtt.emitMessage(makeShadow('ABC'));
    fakeMqtt.emitMessage(makeShadow('DEF'));

    expect(calls1.map((e) => e.deviceId)).toEqual(['ABC', 'DEF']);
    expect(calls2.map((e) => e.deviceId)).toEqual(['ABC', 'DEF']);
  });

  it('buffers events in a ring (last N events retrievable via getRecent)', async () => {
    const mgr = new EventSubscriptionManager({ ringSize: 3 });
    await mgr.subscribe(() => {});
    for (let i = 0; i < 5; i++) fakeMqtt.emitMessage(makeShadow(`D${i}`));
    const recent = mgr.getRecent();
    expect(recent.map((e) => e.deviceId)).toEqual(['D2', 'D3', 'D4']);
  });

  it('getRecent(n) caps to the requested window', async () => {
    const mgr = new EventSubscriptionManager({ ringSize: 10 });
    await mgr.subscribe(() => {});
    for (let i = 0; i < 5; i++) fakeMqtt.emitMessage(makeShadow(`D${i}`));
    expect(mgr.getRecent(2).map((e) => e.deviceId)).toEqual(['D3', 'D4']);
  });

  it('ignores malformed messages (bad JSON) without killing the stream', async () => {
    const mgr = new EventSubscriptionManager();
    const received: DeviceShadowEvent[] = [];
    await mgr.subscribe((e) => received.push(e));

    fakeMqtt.emitter.emit('message', 'topic/x', Buffer.from('not json'));
    fakeMqtt.emitMessage(makeShadow('ABC'));

    expect(received.map((e) => e.deviceId)).toEqual(['ABC']);
  });

  it('isolates subscriber errors — one throwing handler does not break the others', async () => {
    const mgr = new EventSubscriptionManager();
    const good: DeviceShadowEvent[] = [];
    await mgr.subscribe(() => { throw new Error('boom'); });
    await mgr.subscribe((e) => good.push(e));

    fakeMqtt.emitMessage(makeShadow('ABC'));
    expect(good).toHaveLength(1);
  });

  it('shutdown tears down regardless of subscriber count', async () => {
    const mgr = new EventSubscriptionManager();
    await mgr.subscribe(() => {});
    await mgr.subscribe(() => {});
    await mgr.shutdown();
    expect(fakeMqtt.end).toHaveBeenCalledTimes(1);
  });
});
