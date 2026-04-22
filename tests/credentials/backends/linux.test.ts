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

describe('Linux backend — availability', () => {
  it('returns false off linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { linuxAvailable } = await import('../../../src/credentials/backends/linux.js');
    expect(await linuxAvailable()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns true when secret-tool is on PATH and probe succeeds', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    spawnMock
      .mockImplementationOnce(() => makeFakeProc({ stdout: '/usr/bin/secret-tool\n', code: 0 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 0 }));
    const { linuxAvailable } = await import('../../../src/credentials/backends/linux.js');
    expect(await linuxAvailable()).toBe(true);
  });

  it('returns false when secret-tool is absent', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    spawnMock.mockImplementationOnce(() => makeFakeProc({ stdout: '', code: 1 }));
    const { linuxAvailable } = await import('../../../src/credentials/backends/linux.js');
    expect(await linuxAvailable()).toBe(false);
  });
});

describe('Linux backend — get', () => {
  it('looks up both fields via secret-tool lookup', async () => {
    spawnMock
      .mockImplementationOnce(() => makeFakeProc({ stdout: 'T\n', code: 0 }))
      .mockImplementationOnce(() => makeFakeProc({ stdout: 'S\n', code: 0 }));
    const { createLinuxBackend } = await import('../../../src/credentials/backends/linux.js');
    const creds = await createLinuxBackend().get('default');
    expect(creds).toEqual({ token: 'T', secret: 'S' });

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args[0]).toBe('lookup');
    expect(args).toContain('service');
    expect(args).toContain('com.openclaw.switchbot');
    expect(args).toContain('account');
    expect(args).toContain('default:token');
  });

  it('returns null when lookup fails', async () => {
    spawnMock
      .mockImplementationOnce(() => makeFakeProc({ stdout: '', code: 1 }))
      .mockImplementationOnce(() => makeFakeProc({ stdout: '', code: 1 }));
    const { createLinuxBackend } = await import('../../../src/credentials/backends/linux.js');
    expect(await createLinuxBackend().get('default')).toBeNull();
  });
});

describe('Linux backend — set', () => {
  it('writes token and secret via secret-tool store reading stdin', async () => {
    spawnMock
      .mockImplementationOnce(() => makeFakeProc({ code: 0 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 0 }));

    const { createLinuxBackend } = await import('../../../src/credentials/backends/linux.js');
    await createLinuxBackend().set('work', { token: 'tok', secret: 'sec' });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const firstArgs = spawnMock.mock.calls[0][1] as string[];
    expect(firstArgs[0]).toBe('store');
    expect(firstArgs).toContain('--label');
    expect(firstArgs).toContain('work:token');
  });

  it('throws KeychainError on store failure', async () => {
    spawnMock.mockImplementationOnce(() => makeFakeProc({ code: 5, stderr: 'no keyring' }));
    const { createLinuxBackend } = await import('../../../src/credentials/backends/linux.js');
    await expect(createLinuxBackend().set('x', { token: 't', secret: 's' })).rejects.toThrow(
      /secret-tool exit 5/,
    );
  });
});

describe('Linux backend — delete + describe', () => {
  it('clear runs for both fields; exit 0 is success', async () => {
    spawnMock
      .mockImplementationOnce(() => makeFakeProc({ code: 0 }))
      .mockImplementationOnce(() => makeFakeProc({ code: 0 }));
    const { createLinuxBackend } = await import('../../../src/credentials/backends/linux.js');
    await expect(createLinuxBackend().delete('p')).resolves.toBeUndefined();

    const firstArgs = spawnMock.mock.calls[0][1] as string[];
    expect(firstArgs[0]).toBe('clear');
  });

  it('describe reports secret-service tag', async () => {
    const { createLinuxBackend } = await import('../../../src/credentials/backends/linux.js');
    const desc = createLinuxBackend().describe();
    expect(desc.tag).toBe('secret-service');
    expect(desc.writable).toBe(true);
    expect(desc.backend).toMatch(/libsecret/i);
  });
});
