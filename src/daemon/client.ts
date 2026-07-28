import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { getDaemonSocketPath } from './socket-path.js';
import type { JsonRpcResponse } from './server.js';

export interface IpcClientOptions {
  socketPath?: string;
  /** Per-call timeout in milliseconds. Default: 5000ms. */
  timeoutMs?: number;
  /** Connection establishment timeout in milliseconds. Default: 2000ms. */
  connectTimeoutMs?: number;
}

export class IpcDaemonClientError extends Error {
  constructor(message: string, public readonly code?: number, public readonly data?: unknown) {
    super(message);
    this.name = 'IpcDaemonClientError';
  }
}

/**
 * Single-shot JSON-RPC client. Each `call()` opens a socket, sends one
 * request, awaits the matching response, and closes. This keeps the client
 * stateless — callers don't have to manage a connection lifecycle, and the
 * daemon doesn't have to deal with hung connections.
 *
 * For workloads that issue many calls back-to-back (e.g. `mcp serve
 * --via-daemon` proxying tool calls), connection pooling can be added later
 * without changing this surface.
 */
export class IpcDaemonClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;

  constructor(opts: IpcClientOptions = {}) {
    this.socketPath = opts.socketPath ?? getDaemonSocketPath();
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 2_000;
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Sends a JSON-RPC request and resolves with the `result` field. Throws
   * IpcDaemonClientError on transport failure, parse failure, timeout, or
   * server-side error.
   */
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = randomUUID();
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = '';
      let settled = false;

      const finish = (err: IpcDaemonClientError | null, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(callTimer);
        clearTimeout(connectTimer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value as T);
      };

      const callTimer = setTimeout(() => {
        finish(new IpcDaemonClientError(`IPC call to ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      const connectTimer = setTimeout(() => {
        finish(new IpcDaemonClientError(`IPC connect timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      socket.setEncoding('utf-8');
      socket.on('connect', () => {
        clearTimeout(connectTimer);
        socket.write(request);
      });
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx === -1) return;
        const line = buffer.slice(0, newlineIdx).trim();
        if (!line) return;
        try {
          const response = JSON.parse(line) as JsonRpcResponse;
          if ('error' in response) {
            finish(new IpcDaemonClientError(
              response.error.message,
              response.error.code,
              response.error.data,
            ));
            return;
          }
          finish(null, response.result as T);
        } catch (err) {
          finish(new IpcDaemonClientError(`Malformed JSON-RPC response: ${err instanceof Error ? err.message : String(err)}`));
        }
      });
      socket.on('error', (err: NodeJS.ErrnoException) => {
        const code = err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
          ? `IPC daemon not listening at ${this.socketPath} (${err.code})`
          : `IPC socket error: ${err.message}`;
        finish(new IpcDaemonClientError(code));
      });
      socket.on('end', () => {
        if (!settled) finish(new IpcDaemonClientError('IPC server closed connection before responding'));
      });
    });
  }

  /**
   * Quick reachability probe. Resolves with the latency in milliseconds when
   * the daemon responds to `daemon.status`; rejects otherwise.
   */
  async ping(): Promise<{ latencyMs: number; status: unknown }> {
    const start = Date.now();
    const status = await this.call<unknown>('daemon.status');
    return { latencyMs: Date.now() - start, status };
  }
}
