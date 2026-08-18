import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const pkgJson = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));
const pluginRoots = [
  ['package root', resolve(__dirname, '..')],
  ['marketplace plugin', resolve(__dirname, '../plugins/switchbot')],
];

describe('Codex plugin hooks', () => {
  for (const [label, pluginRoot] of pluginRoots) {
    it(`${label} does not declare the unsupported onInstall hook`, () => {
      const manifestPath = resolve(pluginRoot, '.codex-plugin/plugin.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const hooksPath = resolve(pluginRoot, '.codex-plugin/hooks.json');

      assert.equal(manifest.hooks, undefined, `${label}: plugin manifest must not reference hooks.json`);
      assert.equal(existsSync(hooksPath), false, `${label}: unsupported hooks.json must not be shipped`);
    });
  }

  it('switchbot-codex-auth is declared in package.json#bin', () => {
    const bin = pkgJson?.bin ?? {};
    assert.ok(
      Object.prototype.hasOwnProperty.call(bin, 'switchbot-codex-auth'),
      'switchbot-codex-auth must be declared in package.json#bin so the hook command is on PATH after npm install -g'
    );
  });
});
