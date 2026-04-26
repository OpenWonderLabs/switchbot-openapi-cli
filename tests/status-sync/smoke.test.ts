import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectJsonEnvelopeShape } from '../helpers/contracts.js';

const cli = path.resolve(import.meta.dirname, '../../dist/index.js');

function run(args: string[], env?: Record<string, string>) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
}

describe('status-sync smoke (no credentials required)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-smoke-'));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('status-sync --help exits 0 and lists subcommands', () => {
    const r = run(['status-sync', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/run/);
    expect(r.stdout).toMatch(/start/);
    expect(r.stdout).toMatch(/stop/);
    expect(r.stdout).toMatch(/status/);
  });

  it('status-sync status --json reports not running when state dir is empty', () => {
    const r = run(['--json', 'status-sync', 'status', '--state-dir', stateDir]);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    const data = expectJsonEnvelopeShape(json, [
      'running',
      'pid',
      'startedAt',
      'stateDir',
      'stateFile',
      'stdoutLog',
      'stderrLog',
      'command',
      'openclawUrl',
      'openclawModel',
      'topic',
      'configPath',
      'profile',
    ]) as { running: boolean; pid: number | null; stateDir: string };
    expect(data.running).toBe(false);
    expect(data.pid).toBeNull();
    expect(data.stateDir).toBe(stateDir);
  });

  it('status-sync stop exits 0 and prints "not running" when nothing is running', () => {
    const r = run(['status-sync', 'stop', '--state-dir', stateDir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/not running/i);
  });

  it('status-sync status --json stateDir matches custom --state-dir', () => {
    const custom = path.join(stateDir, 'custom');
    const r = run(['--json', 'status-sync', 'status', '--state-dir', custom]);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    const data = expectJsonEnvelopeShape(json, [
      'running',
      'pid',
      'startedAt',
      'stateDir',
      'stateFile',
      'stdoutLog',
      'stderrLog',
      'command',
      'openclawUrl',
      'openclawModel',
      'topic',
      'configPath',
      'profile',
    ]) as { stateDir: string };
    expect(path.resolve(data.stateDir)).toBe(path.resolve(custom));
  });
});
