import { describe, it, expect, vi, beforeEach } from 'vitest';

const notRunningStatus = {
  running: false, pid: null, startedAt: null,
  stateDir: '/mock/.switchbot/status-sync',
  stateFile: '/mock/.switchbot/status-sync/state.json',
  stdoutLog: '/mock/.switchbot/status-sync/stdout.log',
  stderrLog: '/mock/.switchbot/status-sync/stderr.log',
  command: null, openclawUrl: null, openclawModel: null,
  topic: null, configPath: null, profile: null,
};

const runningStatus = {
  ...notRunningStatus,
  running: true,
  pid: 12345,
  startedAt: '2026-04-25T00:00:00.000Z',
  openclawUrl: 'http://localhost:18789',
  openclawModel: 'home-agent',
};

const managerMock = vi.hoisted(() => ({
  getStatusSyncStatus: vi.fn(),
  startStatusSync: vi.fn(),
  stopStatusSync: vi.fn(),
  runStatusSyncForeground: vi.fn(async () => 0),
}));

vi.mock('../../src/status-sync/manager.js', () => managerMock);

import { registerStatusSyncCommand } from '../../src/commands/status-sync.js';
import { runCli } from '../helpers/cli.js';

describe('status-sync start', () => {
  beforeEach(() => {
    managerMock.startStatusSync.mockReset().mockReturnValue(runningStatus);
    managerMock.getStatusSyncStatus.mockReset().mockReturnValue(notRunningStatus);
  });

  it('prints "Started status-sync (PID …)" on success', async () => {
    const res = await runCli(registerStatusSyncCommand, [
      'status-sync', 'start', '--openclaw-model', 'home-agent',
    ]);
    expect(res.exitCode).toBeNull();
    expect(res.stdout.join(' ')).toMatch(/started status-sync/i);
    expect(res.stdout.join(' ')).toContain('12345');
  });

  it('--json emits the StatusSyncStatus object on success', async () => {
    const res = await runCli(registerStatusSyncCommand, [
      '--json', 'status-sync', 'start', '--openclaw-model', 'home-agent',
    ]);
    expect(res.exitCode).toBeNull();
    const body = JSON.parse(res.stdout.join('')) as { data: { running: boolean; pid: number } };
    expect(body.data.running).toBe(true);
    expect(body.data.pid).toBe(12345);
  });

  it('exits non-zero and calls handleError when startStatusSync throws', async () => {
    managerMock.startStatusSync.mockImplementation(() => {
      throw Object.assign(new Error('already running (PID 9000). Run stop first.'), { exitCode: 2 });
    });
    const res = await runCli(registerStatusSyncCommand, ['status-sync', 'start']);
    expect(res.exitCode).not.toBe(0);
    expect(res.exitCode).not.toBeNull();
  });
});

describe('status-sync stop', () => {
  beforeEach(() => {
    managerMock.stopStatusSync.mockReset()
      .mockReturnValue({ stopped: false, stale: false, pid: null, status: notRunningStatus });
  });

  it('prints "not running" when nothing is running', async () => {
    const res = await runCli(registerStatusSyncCommand, ['status-sync', 'stop']);
    expect(res.exitCode).toBeNull();
    expect(res.stdout.join(' ')).toMatch(/not running/i);
  });

  it('prints "Stopped status-sync (PID …)" when process was killed', async () => {
    managerMock.stopStatusSync.mockReturnValue({ stopped: true, stale: false, pid: 7777, status: notRunningStatus });
    const res = await runCli(registerStatusSyncCommand, ['status-sync', 'stop']);
    expect(res.exitCode).toBeNull();
    expect(res.stdout.join(' ')).toMatch(/stopped status-sync/i);
    expect(res.stdout.join(' ')).toContain('7777');
  });

  it('prints "Removed stale" when process is gone but state file existed', async () => {
    managerMock.stopStatusSync.mockReturnValue({ stopped: false, stale: true, pid: 6666, status: notRunningStatus });
    const res = await runCli(registerStatusSyncCommand, ['status-sync', 'stop']);
    expect(res.exitCode).toBeNull();
    expect(res.stdout.join(' ')).toMatch(/stale/i);
  });
});
