import type { IClientOptions } from 'mqtt';
import { connect } from 'mqtt';
import type { MqttClient } from 'mqtt';
import type { MqttCredential } from './credential.js';

export type MqttState = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'disabled';
export type CredentialRefreshCallback = () => Promise<MqttCredential>;

export class SwitchBotMqttClient {
  private client: MqttClient | null = null;
  private credential: MqttCredential;
  private state: MqttState = 'connecting';
  private credentialExpired = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private handlers: Set<(state: MqttState) => void> = new Set();
  private messageHandlers: Set<(topic: string, payload: Buffer) => void> = new Set();
  private credentialRefreshCallback?: CredentialRefreshCallback;
  private stableTimer: NodeJS.Timeout | null = null;

  constructor(credential: MqttCredential, onCredentialExpired?: CredentialRefreshCallback) {
    this.credential = credential;
    this.credentialRefreshCallback = onCredentialExpired;
  }

  async connect(): Promise<void> {
    if (this.client && this.state === 'connected') return;

    this.setState('connecting');
    this.credentialExpired = false;
    this.reconnectAttempts = 0;

    try {
      const { tls, brokerUrl, clientId } = this.credential;
      const ca = Buffer.from(tls.caBase64, 'base64');
      const cert = Buffer.from(tls.certBase64, 'base64');
      const key = Buffer.from(tls.keyBase64, 'base64');

      const options: IClientOptions = {
        clientId,
        ca,
        cert,
        key,
        rejectUnauthorized: true,
        clean: true,
        reconnectPeriod: 0,
        connectTimeout: 30000,
        keepalive: 60,
        reschedulePings: true,
      };

      this.client = connect(brokerUrl, options);

      this.client.on('connect', () => {
        this.reconnectAttempts = 0;
        this.setState('connected');
        this.credentialExpired = false;
      });

      this.client.on('message', (topic, payload) => {
        for (const handler of this.messageHandlers) {
          handler(topic, payload);
        }
      });

      this.client.on('error', (err) => {
        if (
          err instanceof Error &&
          (err.message.includes('certificate') ||
            err.message.includes('ECONNRESET') ||
            err.message.includes('handshake'))
        ) {
          this.credentialExpired = true;
        }
      });

      this.client.on('close', () => {
        this.clearStableTimer();
        if (this.credentialExpired) {
          this.setState('failed');
        } else if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.attemptReconnect();
        } else {
          this.setState('failed');
        }
      });

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

    if (this.credentialExpired && this.credentialRefreshCallback) {
      try {
        this.credential = await this.credentialRefreshCallback();
        this.credentialExpired = false;
      } catch {
        this.setState('failed');
        return;
      }
    }

    const delay = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempts - 1));
    await new Promise((r) => setTimeout(r, delay));

    try {
      await this.connect();
    } catch {
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
        this.client?.end(false, () => resolve());
      });
      this.client = null;
      this.setState('failed');
    }
  }
}
