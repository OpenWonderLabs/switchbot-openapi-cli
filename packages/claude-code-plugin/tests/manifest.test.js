/**
 * Asserts the `.mcp.json` shipped by the Claude Code plugin registers the
 * SwitchBot MCP server using the default profile (no `--tools all`). The
 * v3.8.0 consolidation switched defaults so admin tools are opt-in; this
 * test guards against an accidental revert.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const mcpJsonPath = resolve(__dirname, '../plugins/switchbot/.mcp.json');

describe('claude-code-plugin .mcp.json', () => {
  const manifest = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));

  it('declares mcpServers.switchbot', () => {
    const server = manifest.mcpServers?.switchbot;
    assert.ok(server, 'mcpServers.switchbot must be defined');
    assert.equal(server.command, 'switchbot');
  });

  it('uses the default tool profile (no --tools all)', () => {
    const args = manifest.mcpServers.switchbot.args;
    assert.deepEqual(args, ['mcp', 'serve'], `args must be ["mcp","serve"]; got ${JSON.stringify(args)}`);
    assert.ok(!args.includes('all'), 'args must not include "all"');
    assert.ok(!args.includes('--tools'), 'args must not pass --tools (rely on CLI default=default)');
  });

  it('mcpServers.switchbot has no unsupported fields', () => {
    const server = manifest.mcpServers.switchbot;
    const allowedKeys = new Set(['command', 'args', 'cwd', 'env']);
    for (const key of Object.keys(server)) {
      assert.ok(allowedKeys.has(key), `unexpected field "${key}" in mcpServers.switchbot`);
    }
  });
});
