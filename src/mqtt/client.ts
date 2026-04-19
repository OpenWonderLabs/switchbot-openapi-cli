import { connect as mqttConnect, type MqttClient, type IClientOptions } from 'mqtt';
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

    const tlsOptions: Partial<IClientOptions> = {
      ca: [ca],
      cert: [cert],
      key: [key],
      rejectUnauthorized: true,
    };

    await this.connectWithRetry(credential, tlsOptions);
  }

  private async connectWithRetry(
    credential: MqttCredential,
    tlsOptions: Partial<IClientOptions>,
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

  private doConnect(credential: MqttCredential, tlsOptions: Partial<IClientOptions>): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = credential.brokerUrl;
      const options: IClientOptions = {
        ...tlsOptions,
        clientId: credential.clientId,
        clean: true,
        reconnectPeriod: 0,
        connectTimeout: 30000,
      };

      this.client = mqttConnect(url, options);

      const onConnect = (): void => {
        this.client?.removeListener('error', onError);
        this.client?.removeListener('close', onClose);
        resolve();
      };

      const onError = (err: Error): void => {
        this.client?.removeListener('connect', onConnect);
        this.client?.removeListener('close', onClose);
        reject(err);
      };

      const onClose = (): void => {
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

      this.client.subscribe(topics, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    if (!this.client) throw new Error('Client not connected');
    this.client.on(event as any, handler as any);
  }

  async end(): Promise<void> {
    if (this.reconnectTimeoutId) clearTimeout(this.reconnectTimeoutId);
    if (!this.client) return;
    return new Promise((resolve) => {
      this.client?.end(false, resolve as any);
    });
  }

  async abort(): Promise<void> {
    await this.end();
  }

  checkConnectionStability(): void {
    if (this.connectionStableTime && Date.now() - this.connectionStableTime > 30000) {
      this.reconnectAttempts = 0;
    }
  }
}
