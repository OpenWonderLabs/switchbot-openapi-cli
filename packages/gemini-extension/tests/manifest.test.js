import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(__dirname, '../gemini-extension.json'), 'utf8'));

describe('gemini-extension.json manifest', () => {
  it('has name field as string', () => {
    assert.ok(manifest.name);
    assert.equal(typeof manifest.name, 'string');
  });

  it('has version in semver format', () => {
    assert.ok(manifest.version);
    assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  });

  it('contextFileName points to GEMINI.md', () => {
    assert.equal(manifest.contextFileName, 'GEMINI.md');
  });

  it('mcpServers.switchbot uses switchbot mcp serve --tools all', () => {
    const server = manifest.mcpServers?.switchbot;
    assert.ok(server, 'mcpServers.switchbot must be defined');
    assert.equal(server.command, 'switchbot');
    assert.deepEqual(server.args, ['mcp', 'serve', '--tools', 'all']);
  });

  it('mcpServers.switchbot has no unsupported fields', () => {
    const server = manifest.mcpServers?.switchbot;
    const allowedKeys = new Set(['command', 'args', 'cwd', 'env']);
    for (const key of Object.keys(server)) {
      assert.ok(allowedKeys.has(key), `unexpected field "${key}" in mcpServers.switchbot`);
    }
  });

  it('settings declares SWITCHBOT_TOKEN and SWITCHBOT_SECRET as sensitive', () => {
    assert.ok(Array.isArray(manifest.settings), 'settings must be an array');
    const byEnvVar = Object.fromEntries(manifest.settings.map((s) => [s.envVar, s]));
    assert.ok(byEnvVar.SWITCHBOT_TOKEN, 'SWITCHBOT_TOKEN must be declared');
    assert.ok(byEnvVar.SWITCHBOT_SECRET, 'SWITCHBOT_SECRET must be declared');
    assert.equal(byEnvVar.SWITCHBOT_TOKEN.sensitive, true, 'SWITCHBOT_TOKEN must be sensitive');
    assert.equal(byEnvVar.SWITCHBOT_SECRET.sensitive, true, 'SWITCHBOT_SECRET must be sensitive');
  });

  it('settings entries only use allowed fields (name, description, envVar, sensitive)', () => {
    const allowedKeys = new Set(['name', 'description', 'envVar', 'sensitive']);
    for (const s of manifest.settings) {
      for (const key of Object.keys(s)) {
        assert.ok(allowedKeys.has(key), `unexpected field "${key}" in settings entry ${s.envVar}`);
      }
    }
  });

  it('settings entries each have name and description', () => {
    for (const s of manifest.settings) {
      assert.ok(s.name, `setting ${s.envVar} must have a name`);
      assert.ok(s.description, `setting ${s.envVar} must have a description`);
    }
  });
});
