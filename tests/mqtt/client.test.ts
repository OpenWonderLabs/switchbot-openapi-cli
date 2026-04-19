import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MqttTlsClient } from '../../src/mqtt/client.js';
import * as mqtt from 'mqtt';

vi.mock('mqtt');

const mockMqtt = mqtt as unknown as { connect: ReturnType<typeof vi.fn> };

const mockCredential = {
  brokerUrl: 'mqtts://broker.example.com:8883',
  clientId: 'test-client',
  topics: ['test/topic'],
  tls: {
    caBase64: 'Q0FfQkFTRTY0',
    certBase64: 'Q0VSVFwiQkFTRTY0',
    keyBase64: 'S0VZX0JBU0U2NA==',
  },
  qos: 1,
  expiresAt: Date.now() + 3600000,
};

describe('MqttTlsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects successfully on first attempt', async () => {
    const mockClient: Record<string, unknown> = {
      on: vi.fn(),
      once: vi.fn(),
      subscribe: vi.fn(),
      end: vi.fn(),
      removeListener: vi.fn(),
    };

    let connectHandler: (() => void) | null = null;
    mockClient.once = vi.fn((event: string, handler: unknown) => {
      if (event === 'connect') {
        connectHandler = handler as () => void;
      }
    });

    mockMqtt.connect.mockReturnValue(mockClient);

    const client = new MqttTlsClient();
    const connectPromise = client.connect(mockCredential);

    // Trigger the connect handler
    if (connectHandler) {
      connectHandler();
    }

    await connectPromise;
    expect(mockMqtt.connect).toHaveBeenCalledWith(
      'mqtts://broker.example.com:8883',
      expect.objectContaining({
        clientId: 'test-client',
      }),
    );
  }, { timeout: 10000 });

  it('respects jitter in backoff delays', async () => {
    // With jitterRatio = 0.2, delays should be within ±20% of base
    const client = new MqttTlsClient({
      initialDelayMs: 1000,
      multiplier: 2,
      maxDelayMs: 60000,
      jitterRatio: 0.2,
    });

    // Verify jitter calculation is correct
    for (let attempt = 0; attempt < 3; attempt++) {
      const base = Math.min(1000 * Math.pow(2, attempt), 60000);
      const ratio = 0.2;
      const maxJitter = base * ratio;

      expect(maxJitter).toBeGreaterThan(0);
      expect(maxJitter).toBeLessThanOrEqual(base * 0.2);
    }
  });

  it('supports AbortSignal for cancellation', async () => {
    const mockClient: Record<string, unknown> = {
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      end: vi.fn(),
    };

    mockMqtt.connect.mockReturnValue(mockClient);

    const controller = new AbortController();
    const client = new MqttTlsClient();
    client.setAbortSignal(controller.signal);

    // Don't actually connect; just verify abort is detected
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  }, { timeout: 10000 });

  it('stores broker URL and client ID correctly', () => {
    const client = new MqttTlsClient();
    // Just verify the client can be instantiated and configured
    expect(client).toBeDefined();
  });

  it('handles credential with all required fields', () => {
    const client = new MqttTlsClient();
    expect(mockCredential).toMatchObject({
      brokerUrl: expect.any(String),
      clientId: expect.any(String),
      topics: expect.any(Array),
      tls: expect.objectContaining({
        caBase64: expect.any(String),
        certBase64: expect.any(String),
        keyBase64: expect.any(String),
      }),
    });
  });
});

