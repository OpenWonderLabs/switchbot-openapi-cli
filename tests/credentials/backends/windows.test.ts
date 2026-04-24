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

function decodeEncodedCommand(args: string[]): string {
  const idx = args.indexOf('-EncodedCommand');
  if (idx < 0) throw new Error('missing -EncodedCommand');
  const b64 = args[idx + 1];
  return Buffer.from(b64, 'base64').toString('utf16le');
}

describe('Windows backend — availability', () => {
  it('returns false off win32 without probing', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { windowsAvailable } = await import('../../../src/credentials/backends/windows.js');
    expect(await windowsAvailable()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns true when where.exe finds powershell', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    spawnMock.mockImplementationOnce(() => makeFakeProc({ stdout: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n', code: 0 }));
    const { windowsAvailable } = await import('../../../src/credentials/backends/windows.js');
    expect(await windowsAvailable()).toBe(true);
  });

  it('returns false when powershell is missing', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    spawnMock.mockImplementationOnce(() => makeFakeProc({ stdout: '', code: 1 }));
    const { windowsAvailable } = await import('../../../src/credentials/backends/windows.js');
    expect(await windowsAvailable()).toBe(false);
  });
});

describe('Windows backend — get', () => {
  it('spawns PowerShell with -EncodedCommand and decodes base64 stdout', async () => {
    const tokenB64 = Buffer.from('my-token', 'utf-8').toString('base64');
    const secretB64 = Buffer.from('my-secret', 'utf-8').toString('base64');
    spawnMock
      .mockImplementationOnce(() => makeFakeProc({ stdout: tokenB64, code: 0 }))
      .mockImplementationOnce(() => makeFakeProc({ stdout: secretB64, code: 0 }));

    const { createWindowsBackend } = await import('../../../src/credentials/backends/windows.js');
    const creds = await createWindowsBackend().get('default');
    expect(creds).toEqual({ token: 'my-token', secret: 'my-secret' });

    const [cmd, args, opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(cmd.toLowerCase()).toContain('powershell');
    expect(args).toContain('-NoProfile');
    expect(args).toContain('-EncodedCommand');
    const script = decodeEncodedCommand(args);
    expect(script).toContain('CredReadW');
    expect(opts.env.SWITCHBOT_CRED_TARGET).toBe('com.openclaw.switchbot:default:token');
  });

  it('returns null when CredRead exits non-zero', async () => {
    spawnMock
      .mockImplementationOnce(() => makeFakeProc({ code: 2 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 2 }));
    const { createWindowsBackend } = await import('../../../src/credentials/backends/windows.js');
    expect(await createWindowsBackend().get('default')).toBeNull();
  });
});

describe('Windows backend — set', () => {
  it('passes value through SWITCHBOT_CRED_VALUE env var, not argv', async () => {
    spawnMock
      .mockImplementationOnce(() => makeFakeProc({ code: 2 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 2 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 0 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 0 }));

    const { createWindowsBackend } = await import('../../../src/credentials/backends/windows.js');
    await createWindowsBackend().set('prod', { token: 'tok123', secret: 'sec456' });

    expect(spawnMock).toHaveBeenCalledTimes(4);
    const [, tokenArgs, tokenOpts] = spawnMock.mock.calls[2] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(tokenOpts.env.SWITCHBOT_CRED_VALUE).toBe('tok123');
    expect(tokenOpts.env.SWITCHBOT_CRED_TARGET).toBe('com.openclaw.switchbot:prod:token');
    expect(tokenOpts.env.SWITCHBOT_CRED_USER).toBe('prod:token');
    // ensure no credential value was leaked to argv
    expect(tokenArgs.some((a) => a.includes('tok123'))).toBe(false);

    const [, , secretOpts] = spawnMock.mock.calls[3] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(secretOpts.env.SWITCHBOT_CRED_VALUE).toBe('sec456');
  });

  it('throws KeychainError when CredWrite exits non-zero', async () => {
    spawnMock
      .mockImplementationOnce(() => makeFakeProc({ code: 2 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 2 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 3 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 0 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 0 }));
    const { createWindowsBackend } = await import('../../../src/credentials/backends/windows.js');
    await expect(createWindowsBackend().set('p', { token: 't', secret: 's' })).rejects.toThrow(
      /CredWrite exit 3/,
    );
  });

  it('restores previous fields when the second write fails', async () => {
    const oldTokenB64 = Buffer.from('old-token', 'utf-8').toString('base64');
    const oldSecretB64 = Buffer.from('old-secret', 'utf-8').toString('base64');
    spawnMock
      .mockImplementationOnce(() => makeFakeProc({ stdout: oldTokenB64, code: 0 }))
      .mockImplementationOnce(() => makeFakeProc({ stdout: oldSecretB64, code: 0 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 0 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 3 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 0 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 0 }));

    const { createWindowsBackend } = await import('../../../src/credentials/backends/windows.js');
    await expect(createWindowsBackend().set('prod', { token: 'new-token', secret: 'new-secret' })).rejects.toThrow(
      /CredWrite exit 3/,
    );

    expect(spawnMock).toHaveBeenCalledTimes(6);
    const [, , restoreTokenOpts] = spawnMock.mock.calls[4] as [string, string[], { env: NodeJS.ProcessEnv }];
    const [, , restoreSecretOpts] = spawnMock.mock.calls[5] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(restoreTokenOpts.env.SWITCHBOT_CRED_VALUE).toBe('old-token');
    expect(restoreSecretOpts.env.SWITCHBOT_CRED_VALUE).toBe('old-secret');
  });
});

describe('Windows backend — delete + describe', () => {
  it('calls CredDelete for both fields', async () => {
    spawnMock
      .mockImplementationOnce(() => makeFakeProc({ code: 0 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 0 }));

    const { createWindowsBackend } = await import('../../../src/credentials/backends/windows.js');
    await expect(createWindowsBackend().delete('default')).resolves.toBeUndefined();

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const script = decodeEncodedCommand(args);
    expect(script).toContain('CredDeleteW');
  });

  it('describe reports credman tag', async () => {
    const { createWindowsBackend } = await import('../../../src/credentials/backends/windows.js');
    const desc = createWindowsBackend().describe();
    expect(desc.tag).toBe('credman');
    expect(desc.writable).toBe(true);
    expect(desc.backend).toMatch(/Credential Manager/i);
  });
});
