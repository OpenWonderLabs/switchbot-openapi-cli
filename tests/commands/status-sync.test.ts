import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StatusSyncStatus, StopStatusSyncResult } from '../../src/status-sync/manager.js';
import { expectJsonEnvelopeShape } from '../helpers/contracts.js';

const managerMock = vi.hoisted(() => ({
  getStatusSyncStatus: vi.fn<[], StatusSyncStatus>(),
  startStatusSync: vi.fn<[], StatusSyncStatus>(),
  stopStatusSync: vi.fn<[], StopStatusSyncResult>(),
  runStatusSyncForeground: vi.fn<[], Promise<number>>(),
}));

vi.mock('../../src/status-sync/manager.js', () => managerMock);

import { registerStatusSyncCommand } from '../../src/commands/status-sync.js';
import { runCli } from '../helpers/cli.js';

const NOT_RUNNING: StatusSyncStatus = {
  running: false,
  pid: null,
  startedAt: null,
  stateDir: '/mock/.switchbot/status-sync',
  stateFile: '/mock/.switchbot/status-sync/state.json',
  stdoutLog: '/mock/.switchbot/status-sync/stdout.log',
  stderrLog: '/mock/.switchbot/status-sync/stderr.log',
  command: null,
  openclawUrl: null,
  openclawModel: null,
  topic: null,
  configPath: null,
  profile: null,
};

const RUNNING: StatusSyncStatus = {
  ...NOT_RUNNING,
  running: true,
  pid: 9876,
  startedAt: '2026-04-25T12:00:00.000Z',
  command: ['node', 'src/index.js', 'status-sync', 'run'],
  openclawUrl: 'http://localhost:18789',
  openclawModel: 'home-agent',
};

describe('status-sync command', () => {
  beforeEach(() => {
    managerMock.getStatusSyncStatus.mockReset().mockReturnValue(NOT_RUNNING);
    managerMock.startStatusSync.mockReset().mockReturnValue(RUNNING);
    managerMock.stopStatusSync.mockReset().mockReturnValue({
      stopped: false, stale: false, pid: null, status: NOT_RUNNING,
    });
    managerMock.runStatusSyncForeground.mockReset().mockResolvedValue(0);
  });

  describe('status', () => {
    it('--json exits 0 with running:false when not running', async () => {
      const res = await runCli(registerStatusSyncCommand, ['--json', 'status-sync', 'status']);
      expect(res.exitCode).toBeNull();
      const body = JSON.parse(res.stdout.join('')) as Record<string, unknown>;
      const data = expectJsonEnvelopeShape(body, [
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
      ]) as StatusSyncStatus;
      expect(data.running).toBe(false);
      expect(data.pid).toBeNull();
    });

    it('--json exits 0 with running:true and pid when running', async () => {
      managerMock.getStatusSyncStatus.mockReturnValue(RUNNING);
      const res = await runCli(registerStatusSyncCommand, ['--json', 'status-sync', 'status']);
      expect(res.exitCode).toBeNull();
      const body = JSON.parse(res.stdout.join('')) as Record<string, unknown>;
      const data = expectJsonEnvelopeShape(body, [
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
      ]) as StatusSyncStatus;
      expect(data.running).toBe(true);
      expect(data.pid).toBe(9876);
    });

    it('human mode prints "not running" when not running', async () => {
      const res = await runCli(registerStatusSyncCommand, ['status-sync', 'status']);
      expect(res.exitCode).toBeNull();
      expect(res.stdout.join(' ')).toMatch(/not running/i);
    });
  });

  describe('start', () => {
    it('--json exits 0 and returns running state from startStatusSync', async () => {
      managerMock.startStatusSync.mockReturnValue(RUNNING);
      const res = await runCli(registerStatusSyncCommand, ['--json', 'status-sync', 'start']);
      expect(res.exitCode).toBeNull();
      const body = JSON.parse(res.stdout.join('')) as Record<string, unknown>;
      const data = expectJsonEnvelopeShape(body, [
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
      ]) as StatusSyncStatus;
      expect(data.running).toBe(true);
      expect(data.pid).toBe(9876);
      expect(managerMock.startStatusSync).toHaveBeenCalled();
    });

    it('human mode prints started message with pid', async () => {
      managerMock.startStatusSync.mockReturnValue(RUNNING);
      const res = await runCli(registerStatusSyncCommand, ['status-sync', 'start']);
      expect(res.exitCode).toBeNull();
      expect(res.stdout.join(' ')).toMatch(/started.*9876/i);
    });
  });

  describe('run', () => {
    it('calls runStatusSyncForeground and exits 0 when it resolves 0', async () => {
      managerMock.runStatusSyncForeground.mockResolvedValue(0);
      const res = await runCli(registerStatusSyncCommand, ['status-sync', 'run']);
      expect(res.exitCode).toBeNull();
      expect(managerMock.runStatusSyncForeground).toHaveBeenCalled();
    });

    it('exits with the code returned by runStatusSyncForeground when non-zero', async () => {
      managerMock.runStatusSyncForeground.mockResolvedValue(1);
      const res = await runCli(registerStatusSyncCommand, ['status-sync', 'run']);
      expect(res.exitCode).toBe(1);
    });
  });

  describe('stop', () => {
    it('--json exits 0 with stopped:false when nothing is running', async () => {
      const res = await runCli(registerStatusSyncCommand, ['--json', 'status-sync', 'stop']);
      expect(res.exitCode).toBeNull();
      const body = JSON.parse(res.stdout.join('')) as Record<string, unknown>;
      const data = expectJsonEnvelopeShape(body, ['stopped', 'stale', 'pid', 'status']) as StopStatusSyncResult;
      expect(data.stopped).toBe(false);
      expect(data.pid).toBeNull();
    });

    it('human mode prints "not running" when nothing to stop', async () => {
      const res = await runCli(registerStatusSyncCommand, ['status-sync', 'stop']);
      expect(res.exitCode).toBeNull();
      expect(res.stdout.join(' ')).toMatch(/not running/i);
    });

    it('--json exits 0 with stopped:true when a running bridge is stopped', async () => {
      managerMock.stopStatusSync.mockReturnValue({
        stopped: true, stale: false, pid: 9876, status: NOT_RUNNING,
      });
      const res = await runCli(registerStatusSyncCommand, ['--json', 'status-sync', 'stop']);
      expect(res.exitCode).toBeNull();
      const body = JSON.parse(res.stdout.join('')) as Record<string, unknown>;
      const data = expectJsonEnvelopeShape(body, ['stopped', 'stale', 'pid', 'status']) as StopStatusSyncResult;
      expect(data.stopped).toBe(true);
      expect(data.pid).toBe(9876);
    });
  });
});
