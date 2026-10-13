import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSwitchBotMcpServer } from '../../src/commands/mcp.js';
import { withRequestContext } from '../../src/lib/request-context.js';
import { EventSubscriptionManager } from '../../src/mcp/events-subscription.js';
import type { RawEvent } from '../../src/mcp/events-subscription.js';

// External MQTT account fixture: the MCP resource must not expose it to beta.
class AlphaEvents extends EventSubscriptionManager {
  override getState() { return 'connected' as const; }
  override getRecentEvents(): RawEvent[] {
    return [{ kind: 'shadow.updated', deviceId: 'ALPHA-BOT', timestamp: 1,
      payload: { account: 'alpha', power: 'ON' } }];
  }
}

describe('MCP event account isolation', () => {
  it('denies a request profile access to another account event resource', async () => {
    const server = withRequestContext({ profile: 'beta' }, () => createSwitchBotMcpServer({
      eventManager: new AlphaEvents(), eventManagerProfile: 'alpha', toolProfile: 'readonly',
    }));
    const client = new Client({ name: 'profile-fixture', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await expect(client.readResource({ uri: 'switchbot://events' })).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
