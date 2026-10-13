import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

describe('Claude publication metadata', () => {
  for (const [file, update] of [
    ['.claude-plugin/marketplace.json', (metadata) => { metadata.plugins[0].version = '0.0.1'; }],
    ['plugins/switchbot/.claude-plugin/plugin.json', (metadata) => { metadata.version = '0.0.1'; }],
  ]) {
    it(`refuses to pack stale ${file}`, () => {
      const work = mkdtempSync(path.join(tmpdir(), 'switchbot-claude-version-'));
      try {
        const candidate = path.join(work, 'candidate');
        cpSync(packageRoot, candidate, {
          recursive: true,
          filter: (source) => !['node_modules', 'tests'].includes(path.basename(source)),
        });
        const target = path.join(candidate, file);
        const metadata = JSON.parse(readFileSync(target, 'utf8'));
        update(metadata);
        writeFileSync(target, JSON.stringify(metadata));
        const args = ['pack', '--dry-run', '--json', '--offline', '--ignore-scripts=false'];
        const npmExecPath = process.env.npm_execpath;
        const result = spawnSync(npmExecPath ? process.execPath : 'npm', npmExecPath ? [npmExecPath, ...args] : args, {
          cwd: candidate,
          env: { ...process.env, NODE_AUTH_TOKEN: '', NPM_TOKEN: '' },
          encoding: 'utf8',
          shell: !npmExecPath && process.platform === 'win32',
          timeout: 15_000,
        });
        assert.equal(result.status, 1, `stale metadata was publishable: ${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout + result.stderr, /version mismatch/);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  }

  it('rejects a stale GitHub repository marketplace before release', () => {
    const work = mkdtempSync(path.join(tmpdir(), 'switchbot-claude-repository-version-'));
    try {
      const marketplacePath = path.join(work, 'marketplace.json');
      writeFileSync(marketplacePath, JSON.stringify({ plugins: [{ name: 'switchbot', version: '0.0.1' }] }));
      const result = spawnSync(process.execPath, [path.join(packageRoot, 'lib', 'verify-release.js'), marketplacePath], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 1, 'stale repository metadata must not pass the release guard');
      assert.match(result.stderr, /version mismatch/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
