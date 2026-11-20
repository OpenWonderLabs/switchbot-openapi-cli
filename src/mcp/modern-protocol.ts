import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ImplementationSchema, LoggingLevelSchema, RequestIdSchema, SUPPORTED_PROTOCOL_VERSIONS, type JSONRPCMessage, type JSONRPCRequest, type JSONRPCErrorResponse, type JSONRPCResultResponse, type RequestId } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { VERSION } from '../version.js';

export const MODERN_VERSION = '2026-07-28';
export const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const CLIENT_KEY = 'io.modelcontextprotocol/clientInfo';
const META = { 'io.modelcontextprotocol/serverInfo': { name: 'switchbot', version: VERSION } };
const PRIVATE_CACHE = { ttlMs: 0, cacheScope: 'private' };
const settings = z.record(z.string(), z.unknown());
const requestMeta = z.object({
  [VERSION_KEY]: z.string(),
  [CAPABILITIES_KEY]: z.object({
    experimental: z.record(z.string(), settings).optional(),
    extensions: z.record(z.string(), settings).optional(),
    roots: settings.optional(),
    sampling: z.object({ context: settings.optional(), tools: settings.optional() }).optional(),
    elicitation: z.object({ form: settings.optional(), url: settings.optional() }).optional(),
  }),
  [CLIENT_KEY]: ImplementationSchema.optional(),
  'io.modelcontextprotocol/logLevel': LoggingLevelSchema.optional(),
});

export interface ModernFeatures {
  tools: ReadonlySet<string>;
  resources: boolean;
  instructions: string;
}
export type Reply = JSONRPCResultResponse | JSONRPCErrorResponse;
export interface ModernDispatcher {
  request(message: JSONRPCRequest, validateHeaders?: () => JSONRPCErrorResponse | undefined): void;
  cancel(id: RequestId): boolean;
}
export const rpcError = (id: RequestId | undefined, code: number, message: string, data?: unknown): JSONRPCErrorResponse =>
  ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined && { data }) } });

const envelope = z.object({ jsonrpc: z.literal('2.0'), id: RequestIdSchema, method: z.string(), params: z.unknown().optional() }).strict();

/** The SDK validates parameters as part of the message schema. Preserve a
 * readable ID and distinguish malformed parameters from a malformed envelope. */
export function invalidRequest(body: unknown): JSONRPCErrorResponse {
  const request = envelope.safeParse(body);
  if (request.success) return rpcError(request.data.id, -32602, 'Invalid request parameters');
  const id = RequestIdSchema.safeParse(body && typeof body === 'object' && 'id' in body ? body.id : undefined);
  return rpcError(id.success ? id.data : undefined, -32600, 'Invalid request');
}

export function hasModernMarker(body: JSONRPCMessage): boolean {
  if (!('method' in body)) return false;
  const meta = body.params?._meta;
  return body.method === 'server/discover' || !!meta && (VERSION_KEY in meta || CAPABILITIES_KEY in meta || CLIENT_KEY in meta);
}

/** Only the SDK's registered application handlers execute tools or read resources.
 * Its legacy client state is never initialized or shared with this dispatcher.
 * The only per-connection bookkeeping is for in-flight requests and cancellation. */
export async function connectModern(server: McpServer, features: ModernFeatures, reply: (response: Reply) => void, legacyVersions = SUPPORTED_PROTOCOL_VERSIONS): Promise<ModernDispatcher> {
  const [client, handlers] = InMemoryTransport.createLinkedPair();
  const pending = new Map<RequestId, string>();
  client.onmessage = (message: JSONRPCMessage) => {
    if (!('id' in message) || message.id === undefined) return;
    const method = pending.get(message.id);
    if (!method) return;
    pending.delete(message.id);
    if ('error' in message) reply(message);
    if ('result' in message) reply({ ...message, result: { ...message.result, resultType: 'complete',
      _meta: { ...message.result._meta, ...META }, ...(method !== 'tools/call' && PRIVATE_CACHE) } });
  };
  await server.connect(handlers);
  const supported = [MODERN_VERSION, ...legacyVersions];
  return {
    cancel(id: RequestId): boolean {
      if (!pending.delete(id)) return false;
      void client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
      return true;
    },
    request(message: JSONRPCRequest, validateHeaders?: () => JSONRPCErrorResponse | undefined): void {
      const { id, method, params } = message;
      const parsed = requestMeta.safeParse(params?._meta);
      if (!parsed.success) {
        return reply(rpcError(id, -32602, 'Invalid per-request MCP metadata'));
      }
      const version = parsed.data[VERSION_KEY];
      const headerError = validateHeaders?.();
      if (headerError) return reply(headerError);
      if (version !== MODERN_VERSION) return reply(rpcError(id, -32022, 'Unsupported protocol version', { requested: version, supported }));
      if (pending.has(id)) return reply(rpcError(id, -32600, 'Request ID is already in use'));
      switch (method) {
        case 'server/discover':
          return reply({ jsonrpc: '2.0', id, result: { resultType: 'complete', supportedVersions: supported,
            capabilities: { tools: {}, ...(features.resources && { resources: {} }) }, instructions: features.instructions, _meta: META, ...PRIVATE_CACHE } });
        case 'tools/call':
          if (typeof params?.name !== 'string' || !features.tools.has(params.name)) return reply(rpcError(id, -32602, 'Unknown tool'));
          break;
        case 'tools/list': break;
        case 'resources/list': case 'resources/templates/list': case 'resources/read':
          if (!features.resources) return reply(rpcError(id, -32601, 'Method not found'));
          if (method === 'resources/read' && (typeof params?.uri !== 'string' || !isAbsoluteUri(params.uri))) {
            return reply(rpcError(id, -32602, 'Expected an absolute resource URI'));
          }
          break;
        default: return reply(rpcError(id, -32601, 'Method not found'));
      }
      if (method.endsWith('/list') && params?.cursor !== undefined && typeof params.cursor !== 'string') {
        return reply(rpcError(id, -32602, 'Expected a string cursor'));
      }
      pending.set(id, method);
      void client.send(message).catch(() => {
        if (pending.delete(id)) reply(rpcError(id, -32603, 'Internal server error'));
      });
    },
  };
}

function isAbsoluteUri(value: string): boolean {
  try { new URL(value); return true; } catch { return false; }
}
