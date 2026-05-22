import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerResetCommand } from '../../src/commands/reset.js';
import { runCli } from '../helpers/cli.js';
import * as nodeFsMock from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const selectMock = vi.fn();

vi.mock('../../src/credentials/keychain.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/credentials/keychain.js')>(
    '../../src/credentials/keychain.js',
  );
  return { ...actual, selectCredentialStore: (...args: unknown[]) => selectMock(...args) };
});

vi.mock('../../src/config.js', () => ({
  listProfiles: () => [],
}));

vi.mock('../../src/lib/request-context.js', () => ({
  getActiveProfile: () => 'default',
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const mocked = {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    rmSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
  return { ...mocked, default: mocked };
});

beforeEach(() => { selectMock.mockReset(); });

describe('reset --dry-run', () => {
  it('lists items that would be deleted without touching filesystem', async () => {
    // --dry-run is a global flag; place it before the subcommand name
    const res = await runCli(registerResetCommand, ['--dry-run', 'reset', '--yes']);
    expect(res.exitCode).toBeNull();
    const output = [...res.stdout, ...res.stderr].join('\n');
    expect(output).toMatch(/dry.run/i);
  });
});

describe('reset --yes (skip confirmation)', () => {
  it('removes items and exits 0 when keychain succeeds', async () => {
    const store = {
      name: 'file',
      delete: vi.fn().mockResolvedValue(undefined),
      describe: () => ({ backend: 'mock', tag: 'file', writable: true }),
    };
    selectMock.mockResolvedValue(store);
    const res = await runCli(registerResetCommand, ['reset', '--yes']);
    expect(res.exitCode).toBeNull();
  });

  it('reports "failed" (not "absent") when keychain delete throws', async () => {
    const store = {
      name: 'file',
      delete: vi.fn().mockRejectedValue(new Error('keychain locked')),
      describe: () => ({ backend: 'mock', tag: 'file', writable: true }),
    };
    selectMock.mockResolvedValue(store);
    const res = await runCli(registerResetCommand, ['reset', '--yes']);
    expect(res.exitCode).toBe(1);
    const output = [...res.stdout, ...res.stderr].join('\n');
    // The credential line should say "failed", not "not found"
    expect(output).toMatch(/Credentials \(default\):.*failed/i);
    expect(output).not.toMatch(/Credentials \(default\):.*not found/i);
  });
});

describe('reset --keep-credentials', () => {
  it('skips keychain deletion and only deletes data files', async () => {
    const res = await runCli(registerResetCommand, ['reset', '--yes', '--keep-credentials']);
    expect(res.exitCode).toBeNull();
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('reset --json', () => {
  it('emits JSON with results array under --json --yes', async () => {
    const store = {
      name: 'file',
      delete: vi.fn().mockResolvedValue(undefined),
      describe: () => ({ backend: 'mock', tag: 'file', writable: true }),
    };
    selectMock.mockResolvedValue(store);

    // --json is a global flag; place it before the subcommand name
    const res = await runCli(registerResetCommand, ['--json', 'reset', '--yes']);
    expect(res.exitCode).toBeNull();

    const output = res.stdout.join('\n');
    const parsed = JSON.parse(output) as Record<string, unknown>;
    // printJson wraps in { schemaVersion, data } envelope
    expect(parsed).toHaveProperty('schemaVersion');
    const data = parsed['data'] as Record<string, unknown>;
    expect(data).toHaveProperty('reset', true);
    expect(Array.isArray(data['results'])).toBe(true);
  });

  it('exits 1 under --json when a keychain delete fails', async () => {
    const store = {
      name: 'file',
      delete: vi.fn().mockRejectedValue(new Error('keychain locked')),
      describe: () => ({ backend: 'mock', tag: 'file', writable: true }),
    };
    selectMock.mockResolvedValue(store);

    const res = await runCli(registerResetCommand, ['--json', 'reset', '--yes']);
    expect(res.exitCode).toBe(1);

    const output = res.stdout.join('\n');
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const data = parsed['data'] as Record<string, unknown>;
    const results = data['results'] as Array<{ status: string }>;
    expect(results.some((r) => r.status === 'failed')).toBe(true);
  });
});

describe('reset --config <path>', () => {
  beforeEach(() => { vi.mocked(nodeFsMock.existsSync).mockClear(); });

  it('checks for data files adjacent to the --config file, not under ~/.switchbot', async () => {
    const altConfigDir = path.join(os.tmpdir(), 'sb-alt-reset-test');
    const altConfigFile = path.join(altConfigDir, 'config.json');

    await runCli(registerResetCommand, [
      '--config', altConfigFile,
      'reset', '--yes', '--keep-credentials',
    ]);

    const existsSpy = vi.mocked(nodeFsMock.existsSync);
    const checkedPaths = existsSpy.mock.calls.map((c) => path.normalize(String(c[0])));

    // Config-aware files should be checked in the alt dir
    expect(checkedPaths).toContain(path.normalize(path.join(altConfigDir, 'devices.json')));
    expect(checkedPaths).toContain(path.normalize(path.join(altConfigDir, 'status.json')));
    expect(checkedPaths).toContain(path.normalize(path.join(altConfigDir, 'device-meta.json')));

    // ~/.switchbot/devices.json must NOT be checked when --config is set
    expect(checkedPaths).not.toContain(
      path.normalize(path.join(os.homedir(), '.switchbot', 'devices.json')),
    );
  });

  it('does not call the global credential store when --config is set', async () => {
    const altConfigDir = path.join(os.tmpdir(), 'sb-alt-reset-creds-test');
    const altConfigFile = path.join(altConfigDir, 'config.json');

    // No --keep-credentials — without the fix, store.delete() would be called here
    await runCli(registerResetCommand, [
      '--config', altConfigFile,
      'reset', '--yes',
    ]);

    // The global credential store must never be touched when --config is active;
    // the override file is removed directly via unlinkSync instead.
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('does not touch a sibling cache/ directory in --config mode', async () => {
    // In --config mode the CLI stores cache files as siblings (devices.json,
    // status.json) — it never creates a `cache/` sub-directory next to the
    // override file. Reset must not blindly rm -rf <configDir>/cache because
    // that path can belong to an unrelated project.
    const altConfigDir = path.join(os.tmpdir(), 'sb-alt-reset-cachedir-test');
    const altConfigFile = path.join(altConfigDir, 'portable.json');
    const siblingCacheDir = path.join(altConfigDir, 'cache');

    // Pretend a cache/ directory exists next to the override (the user's
    // unrelated project files). If reset were to call rmSync on this path,
    // it would silently delete real data.
    vi.mocked(nodeFsMock.existsSync).mockImplementation(
      (p) => path.normalize(String(p)) === path.normalize(siblingCacheDir),
    );

    await runCli(registerResetCommand, [
      '--config', altConfigFile,
      'reset', '--yes', '--keep-credentials',
    ]);

    const rmSpy = vi.mocked(nodeFsMock.rmSync);
    const rmTargets = rmSpy.mock.calls.map((c) => path.normalize(String(c[0])));
    expect(rmTargets).not.toContain(path.normalize(siblingCacheDir));

    // existsSync should never even probe the sibling cache path — the entry
    // must be omitted from dataItems entirely in --config mode.
    const existsTargets = vi
      .mocked(nodeFsMock.existsSync)
      .mock.calls.map((c) => path.normalize(String(c[0])));
    expect(existsTargets).not.toContain(path.normalize(siblingCacheDir));
  });
});
