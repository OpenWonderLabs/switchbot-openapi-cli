import type { IClientOptions } from 'mqtt';
import { connect } from 'mqtt';
import type { MqttClient } from 'mqtt';

export type MqttState = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'disabled';
export type AuthRefreshCallback = () => Promise<{ username: string; password: string }> | { username: string; password: string };

interface MqttClientConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  rejectUnauthorized?: boolean;
}

export class SwitchBotMqttClient {
  private client: MqttClient | null = null;
  private config: MqttClientConfig;
  private state: MqttState = 'connecting';
  private authRefreshNeeded = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private handlers: Set<(state: MqttState) => void> = new Set();
  private messageHandlers: Set<(topic: string, payload: Buffer) => void> = new Set();
  private authRefreshCallback?: AuthRefreshCallback;
  private stableTimer: NodeJS.Timeout | null = null;
  private lastConnectionAttempt = 0;

  constructor(config: MqttClientConfig, onAuthRefreshNeeded?: AuthRefreshCallback) {
    this.config = config;
    this.authRefreshCallback = onAuthRefreshNeeded;
  }

  async connect(): Promise<void> {
    if (this.client && this.state === 'connected') {
      return;
    }

    this.setState('connecting');
    this.authRefreshNeeded = false;
    this.reconnectAttempts = 0;

    try {
      const options: IClientOptions = {
        username: this.config.username,
        password: this.config.password,
        clean: true,
        reconnectPeriod: 0, // Manual reconnect control
        connectTimeout: 10000,
        rejectUnauthorized: this.config.rejectUnauthorized ?? true,
      };

      this.client = connect(`mqtts://${this.config.host}:${this.config.port}`, options);

      this.client.on('connect', () => {
        this.reconnectAttempts = 0;
        this.setState('connected');
        this.authRefreshNeeded = false;
      });

      this.client.on('message', (topic, payload) => {
        for (const handler of this.messageHandlers) {
          handler(topic, payload);
        }
      });

      this.client.on('error', (err) => {
        // Check for auth-related errors
        if (
          (err instanceof Error &&
            (err.message.includes('401') ||
              err.message.includes('Unauthorized') ||
              err.message.includes('EACCES'))) ||
          (err as any).code === 'EACCES'
        ) {
          this.authRefreshNeeded = true;
        }
      });

      this.client.on('close', () => {
        this.clearStableTimer();
        if (this.authRefreshNeeded) {          this.setState('failed');
        } else if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.attemptReconnect();
        } else {
          this.setState('failed');
        }
      });

      // Wait for connection with timeout
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('MQTT connection timeout'));
        }, 15000);

        const onConnect = () => {
          clearTimeout(timeout);
          this.client?.removeListener('error', onError);
          resolve();
        };

        const onError = (err: Error) => {
          clearTimeout(timeout);
          this.client?.removeListener('connect', onConnect);
          reject(err);
        };

        if (this.client?.connected) {
          clearTimeout(timeout);
          resolve();
        } else {
          this.client?.once('connect', onConnect);
          this.client?.once('error', onError);
        }
      });
    } catch (err) {
      this.setState('failed');
      throw err;
    }
  }

  private async attemptReconnect(): Promise<void> {
    this.reconnectAttempts++;
    this.setState('reconnecting');

    if (this.authRefreshNeeded && this.authRefreshCallback) {
      try {
        const refreshed = await this.authRefreshCallback();
        this.config.username = refreshed.username;
        this.config.password = refreshed.password;
        this.authRefreshNeeded = false;
      } catch (err) {
        // Auth refresh failed, mark as failed
        this.setState('failed');
        return;
      }
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s...
    const delay = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempts - 1));
    await new Promise((r) => setTimeout(r, delay));

    try {
      await this.connect();
    } catch (err) {
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        await this.attemptReconnect();
      } else {
        this.setState('failed');
      }
    }
  }

  private setState(newState: MqttState): void {
    if (this.state !== newState) {
      this.state = newState;
      for (const handler of this.handlers) {
        handler(newState);
      }
    }
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  subscribe(topic: string): void {
    if (this.client && this.state === 'connected') {
      this.client.subscribe(topic, (err) => {
        if (err) {
          console.error(`Failed to subscribe to ${topic}:`, err);
        }
      });
    }
  }

  onStateChange(handler: (state: MqttState) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onMessage(handler: (topic: string, payload: Buffer) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  getState(): MqttState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === 'connected' && this.client?.connected === true;
  }

  async disconnect(): Promise<void> {
    this.clearStableTimer();
    if (this.client) {
      await new Promise<void>((resolve) => {
        this.client?.end(false, () => {
          resolve();
        });
      });
      this.client = null;
      this.setState('failed');
    }
  }

  setAuthRefreshCallback(callback: AuthRefreshCallback): void {
    this.authRefreshCallback = callback;
  }
}
