import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Release gates must not interpret a missing optional integration as verified.
describe('required plugin host smoke', () => {
  it('fails required Codex verification when the host is missing', () => {
    const result = spawnSync(process.execPath, [
      'scripts/smoke-codex-route-b-live.mjs', '--require-host',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: '' },
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Codex.*required/i);
  });

  it('fails required Gemini verification when the host is missing', () => {
    const result = spawnSync(process.execPath, [
      'scripts/smoke-gemini-extension-lint.mjs', '--require-host',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: '' },
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Gemini.*required/i);
  });

  it('fails required Codex Route A verification before package operations when the host is missing', () => {
    const binDir = mkdtempSync(path.join(os.tmpdir(), 'switchbot-fake-npm-'));
    const npmPath = path.join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const invocationPath = path.join(binDir, 'npm-invoked');
    const { npm_execpath: _npmExecPath, ...envWithoutNpmExecPath } = process.env;

    try {
      if (process.platform === 'win32') {
        writeFileSync(npmPath, '@echo invoked > "' + invocationPath + '"\r\n@exit /b 1\r\n');
      } else {
        writeFileSync(npmPath, '#!/bin/sh\nprintf invoked > ' + JSON.stringify(invocationPath) + '\nexit 1\n');
        chmodSync(npmPath, 0o755);
      }

      const result = spawnSync(process.execPath, [
        'scripts/smoke-codex-temp-prefix-route-a.mjs', '--require-host',
      ], {
        cwd: process.cwd(),
        env: { ...envWithoutNpmExecPath, PATH: binDir },
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(result.status).toBe(1);
      expect(existsSync(invocationPath)).toBe(false);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
