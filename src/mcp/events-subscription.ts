import { MqttTlsClient } from '../mqtt/client.js';
import { getCredential } from '../mqtt/credential.js';
import { extractShadowEvent } from '../mqtt/shadow.js';
import { setCachedStatus, loadStatusCache } from '../devices/cache.js';
import { loadConfig } from '../config.js';
import type { DeviceShadowEvent } from '../mqtt/types.js';

type EventHandler = (event: DeviceShadowEvent) => void;

const DEFAULT_RING_SIZE = 100;

/**
 * Ref-counted MQTT subscription shared across MCP callers. The first
 * `subscribe()` starts an MqttTlsClient and the last `unsubscribe()` tears it
 * down, so N MCP clients (each with their own `resources/subscribe` call)
 * share one upstream MQTT connection. A ring buffer keeps the most recent N
 * events for `events_recent`.
 */
export class EventSubscriptionManager {
  private client: MqttTlsClient | null = null;
  private clientStarting: Promise<void> | null = null;
  private readonly handlers = new Set<EventHandler>();
  private readonly ring: DeviceShadowEvent[] = [];

  constructor(private readonly ringSize: number = DEFAULT_RING_SIZE) {}

  async subscribe(handler: EventHandler): Promise<() => Promise<void>> {
    this.handlers.add(handler);
    if (this.handlers.size === 1) {
      await this.start();
    } else if (this.clientStarting) {
      await this.clientStarting;
    }
    return async () => {
      this.handlers.delete(handler);
      if (this.handlers.size === 0) {
        await this.stop();
      }
    };
  }

  getRecent(n?: number): DeviceShadowEvent[] {
    const count = n ?? this.ring.length;
    return this.ring.slice(-count);
  }

  async shutdown(): Promise<void> {
    this.handlers.clear();
    await this.stop();
  }

  private async start(): Promise<void> {
    if (this.client) return;
    this.clientStarting = (async () => {
      const config = loadConfig();
      const credential = await getCredential(config.token, config.secret);
      const client = new MqttTlsClient();
      await client.connect(credential);
      client.on('message', (...args: unknown[]) => {
        const payload = args[1];
        if (!(payload instanceof Buffer)) return;
        try {
          const message = JSON.parse(payload.toString('utf-8'));
          const event = extractShadowEvent(message);
          if (!event) return;

          const existing = loadStatusCache().entries[event.deviceId]?.body ?? {};
          setCachedStatus(event.deviceId, { ...existing, ...event.payload });

          this.push(event);
          for (const h of this.handlers) {
            try { h(event); } catch { /* isolate subscriber errors */ }
          }
        } catch {
          // malformed payload — ignore
        }
      });
      this.client = client;
    })();
    try {
      await this.clientStarting;
    } finally {
      this.clientStarting = null;
    }
  }

  private async stop(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) {
      try { await c.end(); } catch { /* best-effort */ }
    }
  }

  private push(event: DeviceShadowEvent): void {
    this.ring.push(event);
    if (this.ring.length > this.ringSize) {
      this.ring.splice(0, this.ring.length - this.ringSize);
    }
  }
}
