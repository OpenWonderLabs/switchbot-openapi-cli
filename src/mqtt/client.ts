import { connect as mqttConnect, type MqttClient } from 'mqtt';
import * as tls from 'node:tls';
import type { MqttCredential } from './types.js';

interface ReconnectConfig {
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  maxAttempts: number;
  jitterRatio: number;
}

const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  initialDelayMs: 1000,
  multiplier: 2,
  maxDelayMs: 60000,
  maxAttempts: 5,
  jitterRatio: 0.2,
};

export class MqttTlsClient {
  private client: MqttClient | null = null;
  private reconnectConfig: ReconnectConfig;
  private connectionStableTime: number | null = null;
  private reconnectAttempts = 0;
  private abortSignal: AbortSignal | null = null;
  private reconnectTimeoutId: NodeJS.Timeout | null = null;

  constructor(reconnectConfig?: Partial<ReconnectConfig>) {
    this.reconnectConfig = { ...DEFAULT_RECONNECT_CONFIG, ...reconnectConfig };
  }

  setAbortSignal(signal: AbortSignal): void {
    this.abortSignal = signal;
    signal.addEventListener('abort', () => this.abort());
  }

  async connect(credential: MqttCredential): Promise<void> {
    const ca = Buffer.from(credential.tls.caBase64, 'base64');
    const cert = Buffer.from(credential.tls.certBase64, 'base64');
    const key = Buffer.from(credential.tls.keyBase64, 'base64');

    const tlsOptions = {
      ca,
      cert,
      key,
      rejectUnauthorized: true,
    };

    await this.connectWithRetry(credential, tlsOptions);
  }

  private async connectWithRetry(
    credential: MqttCredential,
    tlsOptions: tls.SecureContextOptions,
  ): Promise<void> {
    for (let attempt = 0; attempt < this.reconnectConfig.maxAttempts; attempt++) {
      if (this.abortSignal?.aborted) throw new Error('Connection aborted');

      try {
        await this.doConnect(credential, tlsOptions);
        this.reconnectAttempts = 0;
        this.connectionStableTime = Date.now();
        return;
      } catch (err) {
        if (attempt === this.reconnectConfig.maxAttempts - 1) throw err;

        const baseDelay = Math.min(
          this.reconnectConfig.initialDelayMs * Math.pow(this.reconnectConfig.multiplier, attempt),
          this.reconnectConfig.maxDelayMs,
        );
        const jitter = baseDelay * this.reconnectConfig.jitterRatio * (Math.random() * 2 - 1);
        const delay = Math.max(0, baseDelay + jitter);

        await new Promise((resolve) => {
          this.reconnectTimeoutId = setTimeout(resolve, delay);
        });
      }
    }

    throw new Error('MQTT connection failed: max retries exhausted');
  }

  private doConnect(credential: MqttCredential, tlsOptions: tls.SecureContextOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = credential.brokerUrl;
      this.client = mqttConnect(url, {
        clientId: credential.clientId,
        clean: true,
        reconnectPeriod: 0, // Disable auto-reconnect; we handle it
        connectTimeout: 30000,
        ...tlsOptions,
      });

      const onConnect = () => {
        this.client?.removeListener('error', onError);
        this.client?.removeListener('close', onClose);
        resolve();
      };

      const onError = (err: Error) => {
        this.client?.removeListener('connect', onConnect);
        this.client?.removeListener('close', onClose);
        reject(err);
      };

      const onClose = () => {
        this.client?.removeListener('connect', onConnect);
        this.client?.removeListener('error', onError);
        reject(new Error('Connection closed'));
      };

      this.client.once('connect', onConnect);
      this.client.once('error', onError);
      this.client.once('close', onClose);
    });
  }

  subscribeAll(topics: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error('Client not connected'));
        return;
      }

      this.client.subscribe(topics, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    if (!this.client) throw new Error('Client not connected');
    this.client.on(event, handler);
  }

  async end(): Promise<void> {
    if (this.reconnectTimeoutId) clearTimeout(this.reconnectTimeoutId);
    return new Promise((resolve) => {
      if (!this.client) {
        resolve();
        return;
      }
      this.client.end(resolve);
    });
  }

  async abort(): Promise<void> {
    await this.end();
  }

  checkConnectionStability(): void {
    if (this.connectionStableTime && Date.now() - this.connectionStableTime > 30000) {
      // Connection is stable; reset attempt counter
      this.reconnectAttempts = 0;
    }
  }
}
