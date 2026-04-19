import { SwitchBotMqttClient, type MqttState } from '../mqtt/client.js';
import { fetchMqttCredential } from '../mqtt/credential.js';
import { parseFilter, applyFilter, type FilterSyntaxError } from '../utils/filter.js';
import { fetchDeviceList, type Device } from '../lib/devices.js';
import { getCachedDevice } from '../devices/cache.js';
import type { AxiosInstance } from 'axios';
import { createClient } from '../api/client.js';
import { log } from '../logger.js';

export interface ShadowEvent {
  kind: 'shadow.updated';
  deviceId: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface SubscriptionEvent {
  kind: 'events.reconnected' | 'events.dropped';
  timestamp?: number;
  count?: number;
  sinceTs?: number;
}

export type RawEvent = ShadowEvent | SubscriptionEvent;

export interface EventSubscriber {
  id: string;
  handler: (event: RawEvent) => void;
  filter?: string;
  lastActivity: number;
}

export class EventSubscriptionManager {
  private mqttClient: SwitchBotMqttClient | null = null;
  private subscribers: Map<string, EventSubscriber> = new Map();
  private ringBuffer: RawEvent[] = [];
  private ringSize = 1000;
  private typeMap: Map<string, string> = new Map();
  private refreshTypeMapTimer: NodeJS.Timeout | null = null;
  private idleCleanupTimer: NodeJS.Timeout | null = null;
  private getClient?: () => AxiosInstance;
  private lastRefreshAttempt = 0;

  constructor(mqttClient?: SwitchBotMqttClient, getClient?: () => AxiosInstance) {
    this.mqttClient = mqttClient || null;
    this.getClient = getClient;
  }

  async initialize(token: string, secret: string): Promise<void> {
    if (!this.mqttClient) {
      const credential = await fetchMqttCredential(token, secret);

      const client = new SwitchBotMqttClient(credential, () => fetchMqttCredential(token, secret));

      client.onStateChange((state) => {
        if (state === 'connected') {
          this.emit({
            kind: 'events.reconnected',
            timestamp: Date.now(),
          } as SubscriptionEvent);
          client.subscribe(credential.topics.status);
        }
      });

      client.onMessage((topic, payload) => {
        try {
          const data = JSON.parse(payload.toString());
          const deviceId = this.extractDeviceId(topic);
          if (deviceId && data.state) {
            this.addEvent({
              kind: 'shadow.updated',
              deviceId,
              payload: data.state,
              timestamp: Date.now(),
            });
          }
        } catch (err) {
          log.debug({ err, topic }, 'failed to parse shadow payload');
        }
      });

      await client.connect();
      this.mqttClient = client;
    }

    this.scheduleIdleCleanup();
  }

  subscribe(
    id: string,
    handler: (event: RawEvent) => void,
    filter?: string,
  ): () => void {
    // Validate filter syntax if provided
    if (filter) {
      parseFilter(filter);
    }

    const subscriber: EventSubscriber = {
      id,
      handler,
      filter,
      lastActivity: Date.now(),
    };

    this.subscribers.set(id, subscriber);

    // Send recent events that match the filter
    for (const event of this.ringBuffer) {
      if (this.matchesFilter(event, filter)) {
        handler(event);
      }
    }

    return () => {
      this.subscribers.delete(id);
    };
  }

  private addEvent(event: RawEvent): void {
    this.ringBuffer.push(event);

    // Check for overflow
    if (this.ringBuffer.length > this.ringSize) {
      const droppedCount = this.ringBuffer.length - this.ringSize;
      const oldestTimestamp = this.ringBuffer[0]?.timestamp || Date.now();

      // Emit overflow notice to all subscribers
      this.emit({
        kind: 'events.dropped',
        count: droppedCount,
        sinceTs: oldestTimestamp,
      } as SubscriptionEvent);

      // Trim buffer
      this.ringBuffer = this.ringBuffer.slice(-this.ringSize);
    }

    // Broadcast to matching subscribers
    this.emit(event);
  }

  private emit(event: RawEvent): void {
    for (const subscriber of this.subscribers.values()) {
      if (this.matchesFilter(event, subscriber.filter)) {
        subscriber.lastActivity = Date.now();
        subscriber.handler(event);
      }
    }
  }

  private matchesFilter(event: RawEvent, filter?: string): boolean {
    if (!filter) return true;

    // Only filter shadow events
    if (event.kind !== 'shadow.updated') return true;

    try {
      // Parse filter and match against device metadata
      const clauses = parseFilter(filter);
      const deviceId = event.deviceId;

      // Get device info from cache
      const cached = getCachedDevice(deviceId);
      if (!cached) {
        // Lazily refresh type map if device unknown
        this.scheduleTypeMapRefresh();
        return false; // Conservative: drop if unknown
      }

      // Build a Device-compatible shape for applyFilter
      const device: Device = {
        deviceId,
        deviceType: this.typeMap.get(deviceId) || cached.type,
        deviceName: cached.name,
        familyName: cached.familyName,
        roomName: cached.roomName,
        enableCloudService: true,
        hubDeviceId: '',
      };

      // Use applyFilter with single device in list
      const matched = applyFilter(clauses, [device], [], new Map());
      return matched.length > 0;
    } catch {
      return false; // Invalid filter matches nothing
    }
  }

  private scheduleTypeMapRefresh(): void {
    if (this.refreshTypeMapTimer || Date.now() - this.lastRefreshAttempt < 5000) {
      return; // Already scheduled or too recent
    }

    this.refreshTypeMapTimer = setTimeout(async () => {
      this.refreshTypeMapTimer = null;
      this.lastRefreshAttempt = Date.now();

      try {
        const client = this.getClient?.() || createClient();
        const body = await fetchDeviceList(client);
        for (const d of body.deviceList) {
          if (d.deviceType) this.typeMap.set(d.deviceId, d.deviceType);
        }
        for (const ir of body.infraredRemoteList) {
          this.typeMap.set(ir.deviceId, ir.remoteType);
        }
      } catch {
        // Silently fail type map refresh
      }
    }, 100);
  }

  private scheduleIdleCleanup(): void {
    if (this.idleCleanupTimer) return;

    this.idleCleanupTimer = setInterval(() => {
      const now = Date.now();
      const idleThreshold = 10 * 60 * 1000; // 10 minutes

      for (const [id, subscriber] of this.subscribers.entries()) {
        if (now - subscriber.lastActivity > idleThreshold) {
          this.subscribers.delete(id);
        }
      }
    }, 60000); // Check every minute
  }

  private extractDeviceId(topic: string): string | null {
    // Topic format: $aws/things/<deviceId>/shadow/update/accepted
    const match = topic.match(/\$aws\/things\/([^/]+)\/shadow/);
    return match ? match[1] : null;
  }

  getState(): MqttState {
    if (!this.mqttClient) return 'disabled';
    return this.mqttClient.getState();
  }

  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  getRecentEvents(limit = 100): RawEvent[] {
    return this.ringBuffer.slice(-limit);
  }

  async shutdown(): Promise<void> {
    if (this.refreshTypeMapTimer) {
      clearTimeout(this.refreshTypeMapTimer);
    }
    if (this.idleCleanupTimer) {
      clearInterval(this.idleCleanupTimer);
    }
    if (this.mqttClient) {
      await this.mqttClient.disconnect();
      this.mqttClient = null;
    }
    this.subscribers.clear();
    this.ringBuffer = [];
  }
}
