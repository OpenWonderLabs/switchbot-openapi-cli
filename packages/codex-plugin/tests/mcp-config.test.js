/**
 * Asserts the two `.mcp.json` files shipped by the Codex plugin both register
 * the SwitchBot MCP server using the default profile (no `--tools all`).
 *
 * Two paths are checked:
 *   - packages/codex-plugin/.mcp.json (top-level, used by Codex when the
 *     plugin source root is the package itself)
 *   - packages/codex-plugin/plugins/switchbot/.mcp.json (nested layout
 *     used by the marketplace registration)
 *
 * Both must agree.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const PATHS = [
  ['top-level', resolve(__dirname, '../.mcp.json')],
  ['nested',    resolve(__dirname, '../plugins/switchbot/.mcp.json')],
];

describe('codex-plugin .mcp.json (both layouts)', () => {
  for (const [label, p] of PATHS) {
    describe(`${label} at ${p}`, () => {
      const manifest = JSON.parse(readFileSync(p, 'utf8'));

      it('declares mcpServers.switchbot pointing at the switchbot CLI', () => {
        const server = manifest.mcpServers?.switchbot;
        assert.ok(server, `${label}: mcpServers.switchbot must be defined`);
        assert.equal(server.command, 'switchbot');
      });

      it('uses the default tool profile (no --tools all)', () => {
        const args = manifest.mcpServers.switchbot.args;
        assert.deepEqual(args, ['mcp', 'serve'], `${label}: args must be ["mcp","serve"]; got ${JSON.stringify(args)}`);
        assert.ok(!args.includes('all'), `${label}: args must not include "all"`);
        assert.ok(!args.includes('--tools'), `${label}: args must not pass --tools`);
      });
    });
  }
});
