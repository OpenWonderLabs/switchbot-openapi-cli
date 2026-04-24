/**
 * `switchbot auth keychain` subcommand tests. Backends are mocked —
 * these tests only exercise the commander wiring, output shape, and
 * failure branches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { registerAuthCommand } from '../../src/commands/auth.js';

const selectMock = vi.fn();

vi.mock('../../src/credentials/keychain.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/credentials/keychain.js')>(
    '../../src/credentials/keychain.js',
  );
  return {
    ...actual,
    selectCredentialStore: (...args: unknown[]) => selectMock(...args),
  };
});

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option('--json');
  registerAuthCommand(program);
  return program;
}

class ExitError extends Error {
  constructor(public code: number) {
    super(`__exit:${code}__`);
  }
}

async function runCli(argv: string[]): Promise<{ stdout: string[]; stderr: string[]; exitCode: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);

  const program = makeProgram();
  let exitCode = 0;
  const prevArgv = process.argv;
  process.argv = ['node', 'switchbot', ...argv];
  try {
    await program.parseAsync(['node', 'switchbot', ...argv]);
  } catch (err) {
    if (err instanceof ExitError) exitCode = err.code;
    else throw err;
  } finally {
    process.argv = prevArgv;
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stdout, stderr, exitCode };
}

function makeStore(overrides: {
  name?: 'keychain' | 'credman' | 'secret-service' | 'file';
  writable?: boolean;
  getResult?: { token: string; secret: string } | null;
  setImpl?: (profile: string, creds: { token: string; secret: string }) => Promise<void>;
  deleteImpl?: (profile: string) => Promise<void>;
} = {}) {
  return {
    name: overrides.name ?? 'file',
    get: vi.fn().mockResolvedValue(overrides.getResult ?? null),
    set: vi.fn(overrides.setImpl ?? (async () => {})),
    delete: vi.fn(overrides.deleteImpl ?? (async () => {})),
    describe: () => ({
      backend: 'Mock backend',
      tag: overrides.name ?? 'file',
      writable: overrides.writable ?? true,
    }),
  };
}

beforeEach(() => {
  selectMock.mockReset();
});

describe('auth keychain describe', () => {
  it('prints backend/tag/writable in human mode', async () => {
    selectMock.mockResolvedValue(makeStore({ name: 'keychain', writable: true }));
    const res = await runCli(['auth', 'keychain', 'describe']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.join('\n')).toMatch(/backend/i);
    expect(res.stdout.join('\n')).toMatch(/writable: yes/);
  });

  it('emits a JSON envelope under --json', async () => {
    selectMock.mockResolvedValue(makeStore({ name: 'file', writable: true }));
    const res = await runCli(['--json', 'auth', 'keychain', 'describe']);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout[0]);
    expect(parsed.data.tag).toBe('file');
    expect(parsed.data.writable).toBe(true);
  });
});

describe('auth keychain get', () => {
  it('exits 1 when the active profile has no credentials', async () => {
    selectMock.mockResolvedValue(makeStore({ getResult: null }));
    const res = await runCli(['auth', 'keychain', 'get']);
    expect(res.exitCode).toBe(1);
    expect(res.stdout.join('\n')).toContain('No credentials');
  });

  it('shows a masked summary in human mode when credentials exist', async () => {
    selectMock.mockResolvedValue(makeStore({ getResult: { token: 'abcdefghij', secret: 'zyxwv' } }));
    const res = await runCli(['auth', 'keychain', 'get']);
    expect(res.exitCode).toBe(0);
    const joined = res.stdout.join('\n');
    expect(joined).toContain('profile');
    expect(joined).toMatch(/token/i);
    // must not leak either raw value
    expect(joined).not.toContain('abcdefghij');
    expect(joined).not.toContain('zyxwv');
  });

  it('returns length + masked preview under --json', async () => {
    selectMock.mockResolvedValue(makeStore({ getResult: { token: 'tok-1234', secret: 'sec-abcd' } }));
    const res = await runCli(['--json', 'auth', 'keychain', 'get']);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout[0]);
    expect(parsed.data.present).toBe(true);
    expect(parsed.data.token.length).toBe('tok-1234'.length);
    expect(parsed.data.token).not.toHaveProperty('raw');
    expect(parsed.data.token.masked).not.toBe('tok-1234');
  });
});

describe('auth keychain set', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-auth-cmd-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads token/secret from --stdin-file and writes via store.set', async () => {
    const store = makeStore({ writable: true });
    selectMock.mockResolvedValue(store);

    const file = path.join(tmpDir, 'creds.json');
    fs.writeFileSync(file, JSON.stringify({ token: 't-from-file', secret: 's-from-file' }));

    const res = await runCli(['auth', 'keychain', 'set', '--stdin-file', file]);
    expect(res.exitCode).toBe(0);
    expect(store.set).toHaveBeenCalledWith('default', { token: 't-from-file', secret: 's-from-file' });
  });

  it('rejects a non-existent --stdin-file with exit 2', async () => {
    selectMock.mockResolvedValue(makeStore({ writable: true }));
    const res = await runCli(['auth', 'keychain', 'set', '--stdin-file', path.join(tmpDir, 'nope.json')]);
    expect(res.exitCode).toBe(2);
  });

  it('rejects an --stdin-file missing token/secret with exit 2', async () => {
    selectMock.mockResolvedValue(makeStore({ writable: true }));
    const file = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ token: 't' }));
    const res = await runCli(['auth', 'keychain', 'set', '--stdin-file', file]);
    expect(res.exitCode).toBe(2);
  });

  it('refuses to write to a non-writable backend', async () => {
    selectMock.mockResolvedValue(makeStore({ writable: false }));
    const res = await runCli(['auth', 'keychain', 'set', '--stdin-file', path.join(tmpDir, 'doesntmatter.json')]);
    expect(res.exitCode).toBe(1);
  });
});

describe('auth keychain delete', () => {
  it('deletes without prompting when --yes is passed', async () => {
    const store = makeStore({ writable: true });
    selectMock.mockResolvedValue(store);

    const res = await runCli(['auth', 'keychain', 'delete', '--yes']);
    expect(res.exitCode).toBe(0);
    expect(store.delete).toHaveBeenCalledWith('default');
  });

  it('emits a JSON envelope with deleted:true under --json', async () => {
    const store = makeStore({ writable: true });
    selectMock.mockResolvedValue(store);

    const res = await runCli(['--json', 'auth', 'keychain', 'delete', '--yes']);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout[0]);
    expect(parsed.data.deleted).toBe(true);
  });
});

describe('auth keychain migrate', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-auth-migrate-'));
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    if (process.platform === 'win32') process.env.USERPROFILE = tmpHome;
  });
  afterEach(() => {
    process.env.HOME = origHome;
    if (process.platform === 'win32') process.env.USERPROFILE = origUserProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('copies config.json into the keychain and leaves the file intact by default', async () => {
    const store = makeStore({ writable: true });
    selectMock.mockResolvedValue(store);

    const file = path.join(tmpHome, '.switchbot', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ token: 't-src', secret: 's-src', label: 'keep' }));

    const res = await runCli(['auth', 'keychain', 'migrate']);
    expect(res.exitCode).toBe(0);
    expect(store.set).toHaveBeenCalledWith('default', { token: 't-src', secret: 's-src' });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('deletes the source file when --delete-file is passed and no metadata remains', async () => {
    const store = makeStore({ writable: true });
    selectMock.mockResolvedValue(store);

    const file = path.join(tmpHome, '.switchbot', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ token: 't-src', secret: 's-src' }));

    const res = await runCli(['auth', 'keychain', 'migrate', '--delete-file']);
    expect(res.exitCode).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('scrubs token/secret but preserves metadata when --delete-file is passed', async () => {
    const store = makeStore({ writable: true });
    selectMock.mockResolvedValue(store);

    const file = path.join(tmpHome, '.switchbot', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ token: 't-src', secret: 's-src', label: 'keep-me', limits: { dailyCap: 12 } }),
    );

    const res = await runCli(['auth', 'keychain', 'migrate', '--delete-file']);
    expect(res.exitCode).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
      label: 'keep-me',
      limits: { dailyCap: 12 },
    });
  });

  it('exits 2 with usage error when the source file is missing', async () => {
    selectMock.mockResolvedValue(makeStore({ writable: true }));
    const res = await runCli(['auth', 'keychain', 'migrate']);
    expect(res.exitCode).toBe(2);
  });

  it('exits 1 when the source file is missing a token', async () => {
    selectMock.mockResolvedValue(makeStore({ writable: true }));
    const file = path.join(tmpHome, '.switchbot', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ secret: 'only-secret' }));

    const res = await runCli(['auth', 'keychain', 'migrate']);
    expect(res.exitCode).toBe(1);
  });
});
