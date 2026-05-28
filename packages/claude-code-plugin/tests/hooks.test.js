import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const HOOKS_FILES = [
  {
    label: '.claude-plugin/hooks.json (root)',
    path: resolve(pkgRoot, '.claude-plugin', 'hooks.json'),
  },
  {
    label: 'plugins/switchbot/.claude-plugin/hooks.json',
    path: resolve(pkgRoot, 'plugins', 'switchbot', '.claude-plugin', 'hooks.json'),
  },
];

describe('hooks.json files', () => {
  for (const { label, path: hooksPath } of HOOKS_FILES) {
    describe(label, () => {
      it('exists on disk', () => {
        assert.ok(existsSync(hooksPath), `Missing: ${hooksPath}`);
      });

      it('is valid JSON', () => {
        const raw = readFileSync(hooksPath, 'utf8');
        assert.doesNotThrow(() => JSON.parse(raw), `Invalid JSON in ${hooksPath}`);
      });

      it('has onInstall.command === "node"', () => {
        const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
        assert.equal(hooks?.onInstall?.command, 'node',
          `Expected onInstall.command to be "node" in ${hooksPath}`);
      });

      it('onInstall.args[0] resolves to an existing file', () => {
        const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
        const relPath = hooks?.onInstall?.args?.[0];
        assert.ok(typeof relPath === 'string', `onInstall.args[0] must be a string in ${hooksPath}`);
        const resolved = resolve(dirname(hooksPath), relPath);
        assert.ok(existsSync(resolved),
          `onInstall.args[0] "${relPath}" resolves to "${resolved}" which does not exist`);
      });
    });
  }
});
