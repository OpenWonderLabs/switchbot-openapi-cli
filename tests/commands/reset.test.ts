import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerResetCommand } from '../../src/commands/reset.js';
import { runCli } from '../helpers/cli.js';

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
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    rmSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
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
});
