import type { IncomingMessage, ServerResponse } from 'node:http';
import { webcrypto } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { JSONRPCMessageSchema, SUPPORTED_PROTOCOL_VERSIONS, type JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { connectModern, hasModernMarker, invalidRequest, rpcError, VERSION_KEY, type ModernFeatures, type Reply } from './modern-protocol.js';

// HTTP+SSE (2024-11-05) is a different, unimplemented binding.
const LEGACY_HTTP = SUPPORTED_PROTOCOL_VERSIONS.filter(version => version >= '2025-03-26');
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function respond(res: ServerResponse, status: number, body: Reply) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function nameMatches(header: string | string[] | undefined, expected: unknown): boolean {
  if (typeof header !== 'string' || typeof expected !== 'string') return false;
  if (!header.startsWith('=?base64?') || !header.endsWith('?=')) return header === expected;
  const encoded = header.slice(9, -2);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return false;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) === expected; }
  catch { return false; }
}

function headerMismatch(req: IncomingMessage, message: JSONRPCRequest) {
  const { id, method, params } = message;
  const mismatch = (name: string) => rpcError(id, -32020, `Missing or mismatched ${name} header`);
  if (req.headers['mcp-protocol-version'] !== params?._meta?.[VERSION_KEY]) return mismatch('MCP-Protocol-Version');
  if (req.headers['mcp-method'] !== method) return mismatch('Mcp-Method');
  if (method === 'tools/call' || method === 'prompts/get' || method === 'resources/read') {
    if (!nameMatches(req.headers['mcp-name'], method === 'resources/read' ? params?.uri : params?.name)) return mismatch('Mcp-Name');
  } else if (req.headers['mcp-name'] !== undefined) return mismatch('Mcp-Name');
}

/** Invoked only inside the authenticated, rate-limited per-profile request context. */
export async function serveDualEraHttp(req: IncomingMessage, res: ServerResponse, create: () => { server: McpServer; features: ModernFeatures }) {
  if (req.url?.split('?', 1)[0] !== '/mcp') return respond(res, 404, rpcError(undefined, -32600, 'MCP endpoint not found'));
  const version = req.headers['mcp-protocol-version'];
  const modernHeaders = req.headers['mcp-method'] !== undefined || req.headers['mcp-name'] !== undefined ||
    (version !== undefined && (typeof version !== 'string' || !SUPPORTED_PROTOCOL_VERSIONS.includes(version)));
  if (req.method !== 'POST' && modernHeaders) {
    res.setHeader('Allow', 'POST, OPTIONS');
    return respond(res, 405, rpcError(undefined, -32600, 'Use POST for modern MCP'));
  }
  let body: unknown;
  if (req.method === 'POST') {
    if (!req.headers.accept?.includes('application/json') || !req.headers.accept.includes('text/event-stream')) {
      return respond(res, 406, rpcError(undefined, -32600, 'Accept must include application/json and text/event-stream'));
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return respond(res, 415, rpcError(undefined, -32600, 'Expected application/json'));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.resume();
        return respond(res, 413, rpcError(undefined, -32600, 'Request exceeds 4 MiB'));
      }
      chunks.push(chunk);
    }
    try { body = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { return respond(res, 400, rpcError(undefined, -32700, 'Parse error')); }
    const parsed = JSONRPCMessageSchema.safeParse(body);
    if (!parsed.success && !Array.isArray(body)) return respond(res, 400, invalidRequest(body));
    const taggedBatch = Array.isArray(body) && body.some(entry => {
      const item = JSONRPCMessageSchema.safeParse(entry);
      return item.success && hasModernMarker(item.data);
    });
    if (modernHeaders || taggedBatch || (parsed.success && hasModernMarker(parsed.data))) {
      if (!parsed.success || !('method' in parsed.data) || !('id' in parsed.data)) {
        return respond(res, 400, rpcError(undefined, -32600, 'Expected one JSON-RPC request'));
      }
      const request = parsed.data;
      const { server, features } = create();
      res.once('close', () => { void server.close(); });
      const dispatcher = await connectModern(server, features, response => {
        const status = !('error' in response) ? 200 : response.error.code === -32601 ? 404 : response.error.code === -32603 ? 500 : 400;
        respond(res, status, response);
      }, LEGACY_HTTP);
      if (!res.destroyed) dispatcher.request(request, () => headerMismatch(req, request));
      return;
    }
  }

  // SDK v1's Streamable HTTP binding uses global Web Crypto, opt-in on Node 18.
  if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  const { server } = create();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.once('close', () => { void server.close(); });
  await server.connect(transport);
  if (!res.destroyed) await transport.handleRequest(req, res, body);
}
