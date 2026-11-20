import { createInterface } from 'node:readline';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { JSONRPCMessageSchema, isInitializeRequest, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { connectModern, hasModernMarker, invalidRequest, rpcError, type ModernFeatures, type ModernDispatcher } from './modern-protocol.js';

/** One newline-delimited wire, two isolated SDK dispatchers. Initialize selects
 * legacy semantics only for messages without modern per-request metadata. */
export async function connectDualEraStdio(create: () => { server: McpServer; features: ModernFeatures }) {
  const write = (message: JSONRPCMessage) => { process.stdout.write(JSON.stringify(message) + '\n'); };
  const [legacy, handlers] = InMemoryTransport.createLinkedPair();
  const legacyServer = create().server;
  legacy.onmessage = write;
  await legacyServer.connect(handlers);
  let initialized = false;
  let modern: Promise<ModernDispatcher> | undefined;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return write(rpcError(undefined, -32700, 'Parse error')); }
    const parsed = JSONRPCMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return write(invalidRequest(raw));
    }
    const message = parsed.data;
    if ('method' in message && 'id' in message) {
      const tagged = hasModernMarker(message);
      if (!tagged && isInitializeRequest(message)) initialized = true;
      if (tagged || (!initialized && message.method !== 'initialize')) {
        if (!modern) {
          const { server, features } = create();
          modern = connectModern(server, features, write);
        }
        void modern.then(dispatcher => dispatcher.request(message));
        return;
      }
    } else if ('method' in message && message.method === 'notifications/cancelled' && modern) {
      const id = message.params?.requestId;
      if (typeof id === 'string' || typeof id === 'number') {
        void modern.then(dispatcher => { if (!dispatcher.cancel(id)) void legacy.send(message); });
      }
      return;
    }
    if (initialized || ('method' in message && message.method === 'initialize')) void legacy.send(message);
  });
}
