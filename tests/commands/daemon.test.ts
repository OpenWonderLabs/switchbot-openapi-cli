import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 42),
  closeSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(() => 'startup log line A\nstartup log line B'),
}));

const childProcessMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

const pidFileMock = vi.hoisted(() => ({
  readPidFile: vi.fn(() => null),
  writePidFile: vi.fn(),
  clearPidFile: vi.fn(),
  isPidAlive: vi.fn(() => false),
  getDefaultPidFilePaths: vi.fn(() => ({
    dir: '/mock/.switchbot',
    pidFile: '/mock/.switchbot/rules.pid',
    reloadFile: '/mock/.switchbot/rules.reload',
  })),
  writeReloadSentinel: vi.fn(),
  sighupSupported: vi.fn(() => true),
}));

const daemonStateMock = vi.hoisted(() => ({
  DAEMON_LOG_FILE: '/mock/.switchbot/daemon.log',
  DAEMON_PID_FILE: '/mock/.switchbot/daemon.pid',
  DAEMON_STATE_FILE: '/mock/.switchbot/daemon.state.json',
  HEALTHZ_PID_FILE: '/mock/.switchbot/healthz.pid',
  readDaemonState: vi.fn(() => null),
  writeDaemonState: vi.fn(),
}));

vi.mock('node:fs', () => ({ default: fsMock, ...fsMock }));
vi.mock('node:child_process', () => ({ ...childProcessMock }));
vi.mock('../../src/rules/pid-file.js', () => pidFileMock);
vi.mock('../../src/lib/daemon-state.js', () => daemonStateMock);

import { registerDaemonCommand } from '../../src/commands/daemon.js';
import { runCli } from '../helpers/cli.js';

describe('daemon command', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fsMock.mkdirSync.mockClear();
    fsMock.openSync.mockClear();
    fsMock.closeSync.mockClear();
    fsMock.unlinkSync.mockClear();
    fsMock.readFileSync.mockClear();
    childProcessMock.spawn.mockReset();
    pidFileMock.readPidFile.mockReset().mockReturnValue(null);
    pidFileMock.writePidFile.mockClear();
    pidFileMock.clearPidFile.mockClear();
    pidFileMock.isPidAlive.mockReset().mockReturnValue(false);
    daemonStateMock.readDaemonState.mockReset().mockReturnValue(null);
    daemonStateMock.writeDaemonState.mockClear();
  });

  it('spawns rules run via the CLI entry one level above commands/', async () => {
    childProcessMock.spawn.mockReturnValue({
      pid: 12345,
      exitCode: null,
      killed: false,
      unref: vi.fn(),
    });

    const pending = runCli(registerDaemonCommand, ['daemon', 'start']);
    await vi.advanceTimersByTimeAsync(300);
    const res = await pending;

    expect(res.exitCode).toBeNull();
    expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);
    const [execPath, argv, options] = childProcessMock.spawn.mock.calls[0];
    expect(execPath).toBe(process.execPath);
    expect(argv.slice(1)).toEqual(['rules', 'run']);
    expect(argv[0]).toMatch(/[\\/]src[\\/]index\.js$/);
    expect(argv[0]).not.toMatch(/[\\/]commands[\\/]index\.js$/);
    expect(options).toMatchObject({
      detached: true,
      stdio: ['ignore', 42, 42],
      env: expect.any(Object),
    });
    expect(pidFileMock.writePidFile).toHaveBeenCalledWith('/mock/.switchbot/daemon.pid', 12345);
    expect(daemonStateMock.writeDaemonState).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'running', pid: 12345 }),
    );
  });

  it('fails fast and clears the pid file when the daemon exits immediately', async () => {
    childProcessMock.spawn.mockReturnValue({
      pid: 12345,
      exitCode: 1,
      killed: false,
      unref: vi.fn(),
    });

    const pending = runCli(registerDaemonCommand, ['daemon', 'start']);
    await vi.advanceTimersByTimeAsync(300);
    const res = await pending;

    expect(res.exitCode).toBe(1);
    expect(pidFileMock.clearPidFile).toHaveBeenCalledWith('/mock/.switchbot/daemon.pid');
    expect(pidFileMock.writePidFile).not.toHaveBeenCalled();
    expect(daemonStateMock.writeDaemonState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        pid: null,
        failureReason: expect.stringContaining('exited immediately'),
      }),
    );
    expect(res.stderr.join('\n')).toMatch(/exited immediately/i);
  });

  it('includes log tail in the error message when the log file has content', async () => {
    fsMock.readFileSync.mockReturnValue('startup error: MODULE_NOT_FOUND\nCannot find module dist/index.js');
    childProcessMock.spawn.mockReturnValue({
      pid: 12345, exitCode: 1, killed: false, unref: vi.fn(),
    });

    const pending = runCli(registerDaemonCommand, ['daemon', 'start']);
    await vi.advanceTimersByTimeAsync(300);
    const res = await pending;

    expect(res.exitCode).toBe(1);
    expect(res.stderr.join('\n')).toMatch(/Last log lines/i);
    expect(res.stderr.join('\n')).toMatch(/MODULE_NOT_FOUND/);
  });

  it('omits "Last log lines" section when the log file is unreadable', async () => {
    fsMock.readFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    childProcessMock.spawn.mockReturnValue({
      pid: 12345, exitCode: 1, killed: false, unref: vi.fn(),
    });

    const pending = runCli(registerDaemonCommand, ['daemon', 'start']);
    await vi.advanceTimersByTimeAsync(300);
    const res = await pending;

    expect(res.exitCode).toBe(1);
    expect(res.stderr.join('\n')).not.toMatch(/Last log lines/i);
    expect(pidFileMock.clearPidFile).toHaveBeenCalledWith('/mock/.switchbot/daemon.pid');
  });

  it('health server death is non-fatal — daemon start still succeeds and writePidFile called once', async () => {
    // First spawn: main daemon (stays alive)
    // Second spawn: health server (exits immediately)
    childProcessMock.spawn
      .mockReturnValueOnce({ pid: 9001, exitCode: null, killed: false, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 9002, exitCode: 1, killed: false, unref: vi.fn() });

    const pending = runCli(registerDaemonCommand, ['daemon', 'start', '--healthz-port', '3456']);
    await vi.advanceTimersByTimeAsync(500);  // 300ms daemon + 200ms health server
    const res = await pending;

    expect(res.exitCode).toBeNull();
    // writePidFile called only for the main daemon, not for the dead health server
    expect(pidFileMock.writePidFile).toHaveBeenCalledTimes(1);
    expect(pidFileMock.writePidFile).toHaveBeenCalledWith('/mock/.switchbot/daemon.pid', 9001);
    expect(daemonStateMock.writeDaemonState).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'running', pid: 9001 }),
    );
  });
});
