import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('OpenClaw required host gate', () => {
  it.each([
    { status: 'error', format: 'bundle', error: 'Required dependency yaml is missing' },
    { status: 'loaded', format: 'native', error: undefined },
  ])('rejects a $format plugin with status $status and unregisters it', (plugin) => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'switchbot-openclaw-gate-'));
    const hostPath = path.join(work, 'openclaw');
    const installedPath = path.join(work, 'installed');
    const evidencePath = path.join(work, 'evidence.json');
    try {
      writeFileSync(hostPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('2026.10.2-fixture');
else if (args[0] === 'plugins' && args[1] === 'install') fs.writeFileSync(${JSON.stringify(installedPath)}, 'registered');
else if (args[0] === 'plugins' && args[1] === 'list') console.log(JSON.stringify({plugins: [{id: 'switchbot'}]}));
else if (args[0] === 'plugins' && args[1] === 'inspect') console.log(JSON.stringify({plugin: ${JSON.stringify({ ...plugin, id: 'switchbot', bundleFormat: 'claude' })}, mcpServers: [{name: 'switchbot', hasStdioTransport: true}]}));
else if (args[0] === 'plugins' && args[1] === 'uninstall') fs.rmSync(${JSON.stringify(installedPath)}, {force: true});
else if (!(args[0] === 'plugins' && args[1] === 'update')) process.exitCode = 2;
`);
      chmodSync(hostPath, 0o755);
      const result = spawnSync(process.execPath, [
        'scripts/smoke-host-runtime.mjs', '--host', 'openclaw', '--require-host', '--evidence', evidencePath,
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: [work, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
        },
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(result.status, result.stderr || result.stdout).toBe(1);
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
      expect(evidence.status).toBe('blocked');
      expect(evidence.hosts[0].status).toBe('blocked');
      expect(evidence.hosts[0].layers).toContain('bundle-uninstalled');
      expect(existsSync(installedPath)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
  it('passes local bootstrap without an account and never forwards user credentials', () => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'switchbot-openclaw-local-'));
    const installedPath = path.join(work, 'installed');
    const evidencePath = path.join(work, 'evidence.json');
    try {
      const hostPath = path.join(work, 'openclaw');
      writeFileSync(hostPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (!process.env.SWITCHBOT_TOKEN || !process.env.SWITCHBOT_SECRET || process.env.SWITCHBOT_TOKEN === 'sentinel-user-token' || process.env.SWITCHBOT_SECRET === 'sentinel-user-secret') {
  console.error('Local smoke credentials missing or user credentials leaked');
  process.exit(1);
}
if (args[0] === '--version') console.log('2026.10.2-fixture');
else if (args[0] === 'plugins' && args[1] === 'install') fs.writeFileSync(${JSON.stringify(installedPath)}, 'registered');
else if (args[0] === 'plugins' && args[1] === 'list') console.log(JSON.stringify({plugins: [{id: 'switchbot'}]}));
else if (args[0] === 'plugins' && args[1] === 'inspect') console.log(JSON.stringify({plugin: {id: 'switchbot', status: 'loaded', format: 'bundle', bundleFormat: 'claude'}, mcpServers: [{name: 'switchbot', hasStdioTransport: true}]}));
else if (args[0] === 'plugins' && args[1] === 'uninstall') fs.rmSync(${JSON.stringify(installedPath)}, {force: true});
`);
      chmodSync(hostPath, 0o755);
      const result = spawnSync(process.execPath, [
        'scripts/smoke-host-runtime.mjs', '--host', 'openclaw', '--require-host', '--evidence', evidencePath,
      ], {
        env: {
          ...process.env,
          PATH: [work, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
          SWITCHBOT_TOKEN: 'sentinel-user-token',
          SWITCHBOT_SECRET: 'sentinel-user-secret',
          SWITCHBOT_HOST_SMOKE_ALLOW_CREDENTIALS: '1',
        },
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
      expect(evidence.credentialFixture).toBe('dummy-local-only');
      expect(evidence.hosts[0].readonly).toEqual({
        tool: 'device_history', mode: 'raw', resultShape: 'devices', deviceCount: 0,
      });
      expect(existsSync(installedPath)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

