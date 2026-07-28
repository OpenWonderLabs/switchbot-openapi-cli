import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { getDaemonSocketPath } from './socket-path.js';

/**
 * Minimal JSON-RPC 2.0 implementation tailored for the SwitchBot daemon.
 *
 * Wire protocol: each line on the socket is exactly one JSON-RPC message
 * (newline-delimited). This sidesteps Content-Length framing while still
 * being trivial for clients in any language to speak. Requests time out at
 * the client; the server has no per-request timer.
 *
 * Permissions: on POSIX we chmod the socket file to 0600 after binding.
 * On Windows, named pipes default to a DACL granting only the creating user
 * access, which is what we want.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

export interface IpcServerOptions {
  socketPath?: string;
  handlers: Record<string, RpcHandler>;
  onClientError?: (err: Error) => void;
}

export interface IpcServer {
  socketPath: string;
  close: () => Promise<void>;
  /** Returns true while the underlying net.Server is listening. */
  isListening: () => boolean;
}

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INTERNAL = -32603;

/**
 * Starts a JSON-RPC server on the daemon's IPC endpoint. Returns a handle
 * that can be closed to release the socket file (POSIX) or named pipe
 * (Windows). On POSIX, a stale socket file from a previous crash is
 * removed before binding.
 */
export async function startIpcServer(opts: IpcServerOptions): Promise<IpcServer> {
  const socketPath = opts.socketPath ?? getDaemonSocketPath();
  if (process.platform !== 'win32') {
    await ensureParentDir(socketPath);
    await removeStaleSocket(socketPath);
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf-8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        newlineIdx = buffer.indexOf('\n');
        if (!line) continue;
        void handleLine(line, socket, opts);
      }
    });
    socket.on('error', (err: Error) => opts.onClientError?.(err));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch { /* best-effort */ }
  }

  return {
    socketPath,
    isListening: () => server.listening,
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        if (process.platform !== 'win32') {
          try { fs.unlinkSync(socketPath); } catch { /* best-effort */ }
        }
        resolve();
      });
    }),
  };
}

async function handleLine(line: string, socket: net.Socket, opts: IpcServerOptions): Promise<void> {
  let req: JsonRpcRequest;
  let id: string | number | null = null;
  try {
    const parsed = JSON.parse(line) as JsonRpcRequest;
    req = parsed;
    id = parsed.id ?? null;
  } catch (err) {
    send(socket, errorResponse(null, ERR_PARSE, 'Parse error', String(err)));
    return;
  }

  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    send(socket, errorResponse(id, ERR_INVALID_REQUEST, 'Invalid Request: missing jsonrpc:"2.0" or method'));
    return;
  }

  const handler = opts.handlers[req.method];
  if (!handler) {
    send(socket, errorResponse(id, ERR_METHOD_NOT_FOUND, `Method not found: ${req.method}`));
    return;
  }

  try {
    const result = await handler(req.params);
    if (req.id !== undefined) {
      send(socket, { jsonrpc: '2.0', id, result });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(socket, errorResponse(id, ERR_INTERNAL, message));
  }
}

function send(socket: net.Socket, msg: JsonRpcResponse): void {
  if (!socket.writable) return;
  socket.write(JSON.stringify(msg) + '\n');
}

function errorResponse(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

async function ensureParentDir(socketPath: string): Promise<void> {
  const parent = path.dirname(socketPath);
  await fs.promises.mkdir(parent, { recursive: true });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    await fs.promises.unlink(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Permission error or directory: not safe to bind, surface it.
      throw err;
    }
  }
}
