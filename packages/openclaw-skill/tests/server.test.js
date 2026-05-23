import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../index.js';

describe('MCP server', () => {
  it('registers all required tools', () => {
    const server = createServer();
    const names = Object.keys(server._registeredTools);
    const required = ['devices_list', 'devices_status', 'devices_describe', 'devices_command', 'scenes_list', 'scenes_run'];
    for (const name of required) {
      assert.ok(names.includes(name), `tool "${name}" not registered`);
    }
    assert.equal(names.length, required.length, 'unexpected extra tools');
  });
});
