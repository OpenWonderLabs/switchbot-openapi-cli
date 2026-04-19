import { connect as mqttConnect, type MqttClient, type IClientOptions } from 'mqtt';
import type { MqttCredential } from './types.js';
import { MqttError, classifyMqttConnectError } from './errors.js';

interface ReconnectConfig {
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  maxAttempts: number;
  jitterRatio: number;
  stableThresholdMs: number;
}

const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  initialDelayMs: 1000,
  multiplier: 2,
  maxDelayMs: 60000,
  maxAttempts: 5,
  jitterRatio: 0.2,
  stableThresholdMs: 30000,
};

export class MqttTlsClient {
  private client: MqttClient | null = null;
  private reconnectConfig: ReconnectConfig;
  private connectionStableTime: number | null = null;
  private reconnectAttempts = 0;
  private abortSignal: AbortSignal | null = null;
  private reconnectTimeoutId: NodeJS.Timeout | null = null;
  private reconnectSleepReject: ((err: Error) => void) | null = null;
  private credential: MqttCredential | null = null;
  private tlsOptions: Partial<IClientOptions> | null = null;
  private userInitiatedClose = false;
  private runtimeErrorHandler: ((err: MqttError) => void) | null = null;

  constructor(reconnectConfig?: Partial<ReconnectConfig>) {
    this.reconnectConfig = { ...DEFAULT_RECONNECT_CONFIG, ...reconnectConfig };
  }

  setAbortSignal(signal: AbortSignal): void {
    this.abortSignal = signal;
    signal.addEventListener('abort', () => this.abort());
  }

  /** Register a callback for runtime errors (e.g. reconnect loop exhausted). */
  onRuntimeError(handler: (err: MqttError) => void): void {
    this.runtimeErrorHandler = handler;
  }

  async connect(credential: MqttCredential): Promise<void> {
    // Despite the "Base64" name, these fields are literal PEM text in the
    // /iot/credential response. Passing them through Buffer.from(…, 'base64')
    // garbles them; OpenSSL then rejects with "no start line". Pass as-is.
    const tlsOptions: Partial<IClientOptions> = {
      ca: credential.tls.caBase64,
      cert: credential.tls.certBase64,
      key: credential.tls.keyBase64,
      rejectUnauthorized: true,
    };

    this.credential = credential;
    this.tlsOptions = tlsOptions;

    await this.connectWithRetry(credential, tlsOptions, false);
    this.attachRuntimeCloseHandler();
  }

  private attachRuntimeCloseHandler(): void {
    if (!this.client) return;
    // Fire on any close after initial connect has succeeded. The mqtt package
    // emits 'close' on graceful disconnect too, so userInitiatedClose gates it.
    this.client.on('close', () => {
      if (this.userInitiatedClose || this.abortSignal?.aborted) return;
      void this.runtimeReconnect();
    });
  }

  private async runtimeReconnect(): Promise<void> {
    if (!this.credential || !this.tlsOptions) return;
    // If the connection was stable for stableThresholdMs, treat the drop as a
    // fresh failure and reset the attempt counter.
    this.checkConnectionStability();
    try {
      await this.connectWithRetry(this.credential, this.tlsOptions, true);
      this.attachRuntimeCloseHandler();
    } catch (err) {
      const mqttErr =
        err instanceof MqttError
          ? new MqttError(err.message, 'mqtt-disconnected', { retryable: true, hint: err.hint })
          : new MqttError(
              `MQTT reconnect failed: ${err instanceof Error ? err.message : String(err)}`,
              'mqtt-disconnected',
              { retryable: true }
            );
      if (this.runtimeErrorHandler) {
        this.runtimeErrorHandler(mqttErr);
      } else {
        throw mqttErr;
      }
    }
  }

  private async connectWithRetry(
    credential: MqttCredential,
    tlsOptions: Partial<IClientOptions>,
    isReconnect: boolean,
  ): Promise<void> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < this.reconnectConfig.maxAttempts; attempt++) {
      if (this.abortSignal?.aborted) throw new Error('Connection aborted');

      try {
        await this.doConnect(credential, tlsOptions);
        this.reconnectAttempts = 0;
        this.connectionStableTime = Date.now();
        return;
      } catch (err) {
        lastErr = err;
        this.reconnectAttempts = attempt + 1;
        if (attempt === this.reconnectConfig.maxAttempts - 1) break;

        const baseDelay = Math.min(
          this.reconnectConfig.initialDelayMs * Math.pow(this.reconnectConfig.multiplier, attempt),
          this.reconnectConfig.maxDelayMs,
        );
        const jitter = baseDelay * this.reconnectConfig.jitterRatio * (Math.random() * 2 - 1);
        const delay = Math.max(0, baseDelay + jitter);

        try {
          await this.abortableSleep(delay);
        } catch {
          throw new Error('Connection aborted');
        }
      }
    }

    const subKind = isReconnect ? 'mqtt-disconnected' : classifyMqttConnectError(lastErr);
    const baseMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new MqttError(
      `MQTT connection failed after ${this.reconnectConfig.maxAttempts} attempts: ${baseMsg}`,
      subKind,
      { retryable: true },
    );
  }

  private abortableSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.reconnectSleepReject = reject;
      this.reconnectTimeoutId = setTimeout(() => {
        this.reconnectSleepReject = null;
        this.reconnectTimeoutId = null;
        resolve();
      }, ms);
    });
  }

  private doConnect(credential: MqttCredential, tlsOptions: Partial<IClientOptions>): Promise<void> {
    return new Promise((resolve, reject) => {
      // Reconnect path: dispose the old client so stale listeners from a dead
      // TCP connection don't leak into the new one. Mirrors OpenClaw's pattern.
      if (this.client) {
        this.client.removeAllListeners();
        this.client.end(true);
        this.client = null;
      }

      const url = credential.brokerUrl;
      const options: IClientOptions = {
        ...tlsOptions,
        clientId: credential.clientId,
        clean: true,
        reconnectPeriod: 0,
        connectTimeout: 30000,
        keepalive: 60,
        reschedulePings: true,
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
    // mqtt's typed event map is narrower than our generic passthrough.
    this.client.on(event as Parameters<MqttClient['on']>[0], handler as never);
  }

  async end(): Promise<void> {
    this.userInitiatedClose = true;
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
    if (this.reconnectSleepReject) {
      this.reconnectSleepReject(new Error('aborted'));
      this.reconnectSleepReject = null;
    }
    if (!this.client) return;
    return new Promise((resolve) => {
      // mqtt v5 signature: end(force, options?, cb?). Force-disconnect & call back.
      this.client?.end(false, {}, () => resolve());
    });
  }

  async abort(): Promise<void> {
    await this.end();
  }

  /** Reset the retry counter once the connection has been healthy long enough. */
  checkConnectionStability(): void {
    if (
      this.connectionStableTime &&
      Date.now() - this.connectionStableTime > this.reconnectConfig.stableThresholdMs
    ) {
      this.reconnectAttempts = 0;
    }
  }

  /** Exposed for tests. */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }
}
