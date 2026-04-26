import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(),
  closeSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const osMock = vi.hoisted(() => ({
  homedir: vi.fn(() => '/fake/home'),
}));

const childProcessMock = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

const tryLoadConfigMock = vi.hoisted(() => vi.fn());
const getActiveProfileMock = vi.hoisted(() => vi.fn());
const getConfigPathMock = vi.hoisted(() => vi.fn());
const fetchMqttCredentialMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({ default: fsMock, ...fsMock }));
vi.mock('node:os', () => ({ default: osMock, ...osMock }));
vi.mock('node:child_process', () => ({ ...childProcessMock }));
vi.mock('../../src/config.js', () => ({ tryLoadConfig: (...args: unknown[]) => tryLoadConfigMock(...args) }));
vi.mock('../../src/lib/request-context.js', () => ({ getActiveProfile: (...args: unknown[]) => getActiveProfileMock(...args) }));
vi.mock('../../src/utils/flags.js', () => ({ getConfigPath: (...args: unknown[]) => getConfigPathMock(...args) }));
vi.mock('../../src/mqtt/credential.js', () => ({
  fetchMqttCredential: (...args: unknown[]) => fetchMqttCredentialMock(...args),
}));

import {
  buildStatusSyncChildArgs,
  getStatusSyncStatus,
  probeStatusSyncStart,
  resolveStatusSyncPaths,
  startStatusSync,
} from '../../src/status-sync/manager.js';

describe('status-sync manager', () => {
  const originalArgv = process.argv;
  const originalKill = process.kill;
  const originalFetch = globalThis.fetch;
  const killSpy = vi.fn();
  (process as unknown as { kill: typeof process.kill }).kill = killSpy as unknown as typeof process.kill;

  afterAll(() => {
    (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    process.argv = ['node', '/repo/dist/index.js'];
    fsMock.existsSync.mockReset();
    fsMock.readFileSync.mockReset();
    fsMock.writeFileSync.mockReset();
    fsMock.mkdirSync.mockReset();
    fsMock.openSync.mockReset();
    fsMock.closeSync.mockReset();
    fsMock.unlinkSync.mockReset();
    childProcessMock.spawn.mockReset();
    childProcessMock.spawnSync.mockReset();
    tryLoadConfigMock.mockReset();
    getActiveProfileMock.mockReset();
    getConfigPathMock.mockReset();
    fetchMqttCredentialMock.mockReset();
    killSpy.mockReset();
    delete process.env.OPENCLAW_TOKEN;
    delete process.env.OPENCLAW_MODEL;
    delete process.env.OPENCLAW_URL;
    delete process.env.SWITCHBOT_STATUS_SYNC_HOME;
    fsMock.openSync.mockReturnValueOnce(11).mockReturnValueOnce(12);
    tryLoadConfigMock.mockReturnValue({ token: 'token', secret: 'secret' });
    childProcessMock.spawn.mockReturnValue({ pid: 4321, unref: vi.fn() });
    childProcessMock.spawnSync.mockReturnValue({ status: 0 });
    fetchMqttCredentialMock.mockResolvedValue({
      brokerUrl: 'mqtts://broker.example',
      region: 'us-east-1',
      clientId: 'client-1',
      topics: { status: 'topic/status' },
      qos: 1,
      tls: { enabled: true, caBase64: 'ca', certBase64: 'cert', keyBase64: 'key' },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 401, ok: false }) as typeof fetch;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('builds child args that inherit the active profile', () => {
    getActiveProfileMock.mockReturnValue('work');

    const args = buildStatusSyncChildArgs({
      openclawUrl: 'http://localhost:18789',
      openclawModel: 'home-agent',
      topic: 'topic/a',
    });

    expect(args).toEqual([
      path.resolve('/repo/dist/index.js'),
      '--profile',
      'work',
      'events',
      'mqtt-tail',
      '--sink',
      'openclaw',
      '--openclaw-url',
      'http://localhost:18789',
      '--openclaw-model',
      'home-agent',
      '--topic',
      'topic/a',
    ]);
  });

  it('starts a detached child and writes state metadata', () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    getConfigPathMock.mockReturnValue('/custom/config.json');
    fsMock.existsSync.mockReturnValue(false);
    const paths = resolveStatusSyncPaths('/tmp/status-sync');

    const status = startStatusSync({ stateDir: '/tmp/status-sync', topic: 'sb/topic' });

    expect(fsMock.mkdirSync).toHaveBeenCalledWith(paths.stateDir, { recursive: true });
    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        pathFromArgv(),
        '--config',
        expect.stringMatching(/custom[\\/]config\.json$/),
        'events',
        'mqtt-tail',
        '--sink',
        'openclaw',
        '--openclaw-url',
        'http://localhost:18789',
        '--openclaw-model',
        'env-model',
        '--topic',
        'sb/topic',
      ],
      expect.objectContaining({
        detached: true,
        windowsHide: true,
        env: expect.objectContaining({ OPENCLAW_TOKEN: 'env-token' }),
      }),
    );
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      paths.stateFile,
      expect.stringContaining('"pid": 4321'),
      { mode: 0o600 },
    );
    expect(status.running).toBe(true);
    expect(status.pid).toBe(4321);
  });

  it('cleans stale state on status and reports not running', () => {
    const paths = resolveStatusSyncPaths('/tmp/status-sync');
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        pid: 999,
        startedAt: '2026-04-24T00:00:00.000Z',
        command: ['node', 'dist/index.js'],
        stdoutLog: '/tmp/status-sync/stdout.log',
        stderrLog: '/tmp/status-sync/stderr.log',
      }),
    );
    killSpy.mockImplementation(() => {
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    });

    const status = getStatusSyncStatus({ stateDir: '/tmp/status-sync' });

    expect(status.running).toBe(false);
    expect(fsMock.unlinkSync).toHaveBeenCalledWith(paths.stateFile);
  });

  it('reports a running process from the state file', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        pid: process.pid,
        startedAt: '2026-04-24T00:00:00.000Z',
        openclawUrl: 'http://localhost:18789',
        openclawModel: 'home-agent',
        command: ['node', 'dist/index.js'],
        stdoutLog: '/tmp/status-sync/stdout.log',
        stderrLog: '/tmp/status-sync/stderr.log',
      }),
    );

    const status = getStatusSyncStatus({ stateDir: '/tmp/status-sync' });

    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.openclawModel).toBe('home-agent');
  });

  it('resolves the default state dir from SWITCHBOT_STATUS_SYNC_HOME when set', () => {
    process.env.SWITCHBOT_STATUS_SYNC_HOME = '/override/status-sync';
    const paths = resolveStatusSyncPaths();

    expect(paths.stateDir).toMatch(/override[\\/]status-sync$/);
    expect(paths.stateFile).toMatch(/override[\\/]status-sync[\\/]state\.json$/);
    expect(paths.stdoutLog).toMatch(/override[\\/]status-sync[\\/]stdout\.log$/);
    expect(paths.stderrLog).toMatch(/override[\\/]status-sync[\\/]stderr\.log$/);
  });

  it('missing OPENCLAW_TOKEN error names both the flag and the env var and suggests a verify step', () => {
    delete process.env.OPENCLAW_TOKEN;
    process.env.OPENCLAW_MODEL = 'env-model';
    expect(() => startStatusSync({ stateDir: '/tmp/status-sync' })).toThrow(
      /OpenClaw token missing[\s\S]*--openclaw-token[\s\S]*OPENCLAW_TOKEN[\s\S]*status-sync status/,
    );
  });

  it('missing OPENCLAW_MODEL error names both the flag and the env var and suggests a verify step', () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    delete process.env.OPENCLAW_MODEL;
    expect(() => startStatusSync({ stateDir: '/tmp/status-sync' })).toThrow(
      /OpenClaw model missing[\s\S]*--openclaw-model[\s\S]*OPENCLAW_MODEL[\s\S]*status-sync status/,
    );
  });

  it('rejects an invalid OPENCLAW_URL before spawning the child', () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    process.env.OPENCLAW_URL = 'not-a-url';
    expect(() => startStatusSync({ stateDir: '/tmp/status-sync' })).toThrow(
      /OpenClaw URL is invalid[\s\S]*--openclaw-url[\s\S]*OPENCLAW_URL/,
    );
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });

  it('rejects unsupported URL protocols before spawning the child', () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    process.env.OPENCLAW_URL = 'ftp://example.com/openclaw';
    expect(() => startStatusSync({ stateDir: '/tmp/status-sync' })).toThrow(
      /must use http:\/\/ or https:\/\//,
    );
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });

  it('probes MQTT credentials and OpenClaw reachability when requested', async () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';

    const result = await probeStatusSyncStart({});

    expect(fetchMqttCredentialMock).toHaveBeenCalledWith('token', 'secret');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:18789',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer env-token',
          'X-OpenClaw-Model': 'env-model',
        }),
      }),
    );
    expect(result).toEqual({
      openclawUrl: 'http://localhost:18789',
      mqttBrokerUrl: 'mqtts://broker.example',
      mqttRegion: 'us-east-1',
    });
  });

  it('turns MQTT credential probe failures into a usage error', async () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    fetchMqttCredentialMock.mockRejectedValue(new Error('HTTP 401 Unauthorized'));

    await expect(probeStatusSyncStart({})).rejects.toThrow(
      /SwitchBot MQTT credential probe failed[\s\S]*HTTP 401 Unauthorized/,
    );
  });

  it('turns OpenClaw probe failures into a usage error', async () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as typeof fetch;

    await expect(probeStatusSyncStart({})).rejects.toThrow(
      /OpenClaw probe failed[\s\S]*ECONNREFUSED/,
    );
  });
});

function pathFromArgv(): string {
  return path.resolve(process.argv[1]);
}
