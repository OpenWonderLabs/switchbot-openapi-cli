import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createServer,
  MCP_SERVER_NAME,
  MCP_TRANSPORT,
  MCP_ENTRY_COMMAND,
  MCP_ENTRY_ARGS,
  MCP_DELEGATE_COMMAND,
} from '../index.js';

describe('MCP server', () => {
  it('describes the stdio launcher that delegates to the CLI MCP server', () => {
    const server = createServer();
    assert.equal(server.name, MCP_SERVER_NAME);
    assert.equal(server.transport, MCP_TRANSPORT);
    assert.equal(server.command, MCP_ENTRY_COMMAND);
    assert.deepEqual(server.args, MCP_ENTRY_ARGS);
    assert.deepEqual(server.delegateCommand, MCP_DELEGATE_COMMAND);
  });
});
