import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const pluginRoot = resolve(__dirname, '../plugins/switchbot');
const pkgJson = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));

describe('hooks.json', () => {
  const hooksPath = resolve(pluginRoot, '.codex-plugin/hooks.json');

  it('exists on disk', () => {
    assert.ok(existsSync(hooksPath), `hooks.json missing at ${hooksPath}`);
  });

  it('onInstall.command is switchbot-codex-auth (not a relative path)', () => {
    const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
    const cmd = hooks?.onInstall?.command;
    assert.equal(cmd, 'switchbot-codex-auth',
      `onInstall.command must be the global binary "switchbot-codex-auth", got "${cmd}"`);
  });

  it('switchbot-codex-auth is declared in package.json#bin', () => {
    const bin = pkgJson?.bin ?? {};
    assert.ok(
      Object.prototype.hasOwnProperty.call(bin, 'switchbot-codex-auth'),
      'switchbot-codex-auth must be declared in package.json#bin so the hook command is on PATH after npm install -g'
    );
  });
});
