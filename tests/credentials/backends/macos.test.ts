import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

interface FakeProcOptions {
  stdout?: string;
  stderr?: string;
  code?: number;
  error?: boolean;
}

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

function makeFakeProc(opts: FakeProcOptions = {}) {
  const proc: EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  } = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write: vi.fn(), end: vi.fn() },
  });
  process.nextTick(() => {
    if (opts.error) {
      proc.emit('error', new Error('spawn ENOENT'));
      proc.emit('close', 127);
      return;
    }
    if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr));
    proc.emit('close', opts.code ?? 0);
  });
  return proc;
}

const originalPlatform = process.platform;

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

describe('macOS backend — availability', () => {
  it('returns false off darwin without probing security(1)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { macOsAvailable } = await import('../../../src/credentials/backends/macos.js');
    const ok = await macOsAvailable();
    expect(ok).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns true when which finds security', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    spawnMock.mockImplementationOnce(() => makeFakeProc({ stdout: '/usr/bin/security\n', code: 0 }));
    const { macOsAvailable } = await import('../../../src/credentials/backends/macos.js');
    expect(await macOsAvailable()).toBe(true);
  });

  it('returns false when security is not on PATH', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    spawnMock.mockImplementationOnce(() => makeFakeProc({ stdout: '', code: 1 }));
    const { macOsAvailable } = await import('../../../src/credentials/backends/macos.js');
    expect(await macOsAvailable()).toBe(false);
  });
});

describe('macOS backend — get', () => {
  it('reads both token and secret via security find-generic-password', async () => {
    spawnMock
      .mockImplementationOnce(() => makeFakeProc({ stdout: 'TOKEN-VALUE\n', code: 0 }))
      .mockImplementationOnce(() => makeFakeProc({ stdout: 'SECRET-VALUE\n', code: 0 }));

    const { createMacOsBackend } = await import('../../../src/credentials/backends/macos.js');
    const backend = createMacOsBackend();
    const creds = await backend.get('default');

    expect(creds).toEqual({ token: 'TOKEN-VALUE', secret: 'SECRET-VALUE' });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const firstArgs = spawnMock.mock.calls[0][1] as string[];
    expect(firstArgs).toContain('find-generic-password');
    expect(firstArgs).toContain('-s');
    expect(firstArgs).toContain('com.openclaw.switchbot');
    expect(firstArgs).toContain('default:token');
  });

  it('returns null when either read fails', async () => {
    spawnMock
      .mockImplementationOnce(() => makeFakeProc({ stdout: 'TOK\n', code: 0 }))
      .mockImplementationOnce(() => makeFakeProc({ stdout: '', code: 44 }));

    const { createMacOsBackend } = await import('../../../src/credentials/backends/macos.js');
    const creds = await createMacOsBackend().get('default');
    expect(creds).toBeNull();
  });
});

describe('macOS backend — set + delete', () => {
  it('set calls add-generic-password with -U for token then secret', async () => {
    spawnMock
      .mockImplementationOnce(() => makeFakeProc({ code: 0 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 0 }));

    const { createMacOsBackend } = await import('../../../src/credentials/backends/macos.js');
    await createMacOsBackend().set('prod', { token: 'T', secret: 'S' });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const setArgs = spawnMock.mock.calls[0][1] as string[];
    expect(setArgs).toContain('add-generic-password');
    expect(setArgs).toContain('-U');
    expect(setArgs).toContain('prod:token');
    expect(setArgs).toContain('T');
  });

  it('set throws KeychainError when security exits non-zero', async () => {
    spawnMock.mockImplementationOnce(() => makeFakeProc({ code: 45, stderr: 'could not be added' }));

    const { createMacOsBackend } = await import('../../../src/credentials/backends/macos.js');
    await expect(createMacOsBackend().set('default', { token: 't', secret: 's' })).rejects.toThrow(
      /security\(1\) exit 45/,
    );
  });

  it('delete tolerates exit 44 ("not found") as idempotent success', async () => {
    spawnMock
      .mockImplementationOnce(() => makeFakeProc({ code: 44 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 44 }));

    const { createMacOsBackend } = await import('../../../src/credentials/backends/macos.js');
    await expect(createMacOsBackend().delete('default')).resolves.toBeUndefined();
  });
});

describe('macOS backend — describe', () => {
  it('reports keychain tag and writable', async () => {
    const { createMacOsBackend } = await import('../../../src/credentials/backends/macos.js');
    const desc = createMacOsBackend().describe();
    expect(desc.tag).toBe('keychain');
    expect(desc.writable).toBe(true);
    expect(desc.backend).toBe('macOS Keychain');
    expect(desc.notes).toContain('com.openclaw.switchbot');
  });
});
