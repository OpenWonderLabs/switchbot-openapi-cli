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
  runStatusSyncForeground,
  startStatusSync,
  stopStatusSync,
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
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      statusText: 'OK',
      text: () => Promise.resolve(''),
    }) as typeof fetch;
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
    // Probe must hit the actual write endpoint (/v1/chat/completions),
    // not the base URL, so misconfigurations surface at --probe time
    // instead of after the daemon is running.
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:18789/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer env-token',
          'content-type': 'application/json',
        }),
      }),
    );
    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe('env-model');
    expect(body.messages).toEqual([{ role: 'user', content: 'status-sync probe' }]);
    expect(result).toEqual({
      openclawUrl: 'http://localhost:18789',
      mqttBrokerUrl: 'mqtts://broker.example',
      mqttRegion: 'us-east-1',
    });
  });

  it('rejects with an auth hint when OpenClaw returns 401', async () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('{"error":"invalid token"}'),
    }) as typeof fetch;

    await expect(probeStatusSyncStart({})).rejects.toThrow(
      /OpenClaw probe failed[\s\S]*HTTP 401[\s\S]*token/i,
    );
  });

  it('rejects with a URL-path hint when OpenClaw returns 404', async () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
      statusText: 'Not Found',
      text: () => Promise.resolve(''),
    }) as typeof fetch;

    await expect(probeStatusSyncStart({})).rejects.toThrow(
      /HTTP 404[\s\S]*\/v1\/chat\/completions/,
    );
  });

  it('trims trailing slash on base URL before appending the probe path', async () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    process.env.OPENCLAW_URL = 'http://host.example:9000/';

    await probeStatusSyncStart({});

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://host.example:9000/v1/chat/completions',
      expect.anything(),
    );
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

  // ── stopStatusSync ────────────────────────────────────────────────────────

  it('stopStatusSync returns stopped:false when no state file exists', () => {
    fsMock.existsSync.mockReturnValue(false);
    const paths = resolveStatusSyncPaths('/tmp/status-sync');

    const result = stopStatusSync({ stateDir: '/tmp/status-sync' });

    expect(result.stopped).toBe(false);
    expect(result.stale).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.status.running).toBe(false);
    expect(result.status.stateDir).toBe(paths.stateDir);
  });

  it('stopStatusSync returns stale:true when state file exists but process is gone', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        pid: 8888,
        startedAt: '2026-01-01T00:00:00.000Z',
        command: ['node', 'index.js'],
        stdoutLog: '/tmp/status-sync/stdout.log',
        stderrLog: '/tmp/status-sync/stderr.log',
      }),
    );
    // process.kill(8888, 0) throws ESRCH → process not running
    killSpy.mockImplementation(() => {
      const err = new Error('No such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    const result = stopStatusSync({ stateDir: '/tmp/status-sync' });

    expect(result.stopped).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.pid).toBe(8888);
    expect(fsMock.unlinkSync).toHaveBeenCalled();
  });

  it('stopStatusSync kills the process and returns stopped:true on win32', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        pid: 7777,
        startedAt: '2026-01-01T00:00:00.000Z',
        command: ['node', 'index.js'],
        stdoutLog: '/tmp/status-sync/stdout.log',
        stderrLog: '/tmp/status-sync/stderr.log',
      }),
    );
    // First kill(pid, 0) succeeds (process is running), then after taskkill
    // the second kill(pid, 0) throws ESRCH (process is gone)
    let killCallCount = 0;
    killSpy.mockImplementation(() => {
      killCallCount++;
      if (killCallCount >= 2) {
        const err = new Error('No such process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      // First call succeeds (process exists)
    });

    const result = stopStatusSync({ stateDir: '/tmp/status-sync' });

    // On win32, taskkill is called; on other platforms SIGTERM is sent
    // Either way, stopped should be true after the process is gone
    expect(result.stopped).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.pid).toBe(7777);
    expect(result.status.running).toBe(false);
    expect(fsMock.unlinkSync).toHaveBeenCalled();
  });

  it('stopStatusSync throws when process is still running after kill attempt', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        pid: 6666,
        startedAt: '2026-01-01T00:00:00.000Z',
        command: ['node', 'index.js'],
        stdoutLog: '/tmp/status-sync/stdout.log',
        stderrLog: '/tmp/status-sync/stderr.log',
      }),
    );
    // All kill signals succeed (process stays alive throughout)
    killSpy.mockReturnValue(undefined);
    // spawnSync taskkill succeeds but process is still alive
    childProcessMock.spawnSync.mockReturnValue({ status: 0, error: undefined });

    expect(() => stopStatusSync({ stateDir: '/tmp/status-sync' })).toThrow(
      /Failed to stop status-sync process/,
    );
  });

  // ── startStatusSync --force ───────────────────────────────────────────────

  it('startStatusSync throws UsageError when already running without --force', () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    // Make getStatusSyncStatus report running by providing a live PID
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        pid: process.pid,
        startedAt: '2026-01-01T00:00:00.000Z',
        command: ['node', 'index.js'],
        openclawUrl: 'http://localhost:18789',
        openclawModel: 'env-model',
        stdoutLog: '/tmp/status-sync/stdout.log',
        stderrLog: '/tmp/status-sync/stderr.log',
      }),
    );

    expect(() => startStatusSync({ stateDir: '/tmp/status-sync' })).toThrow(
      /already running/,
    );
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });

  it('startStatusSync stops existing process then starts fresh when --force is set', () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    let existsCallCount = 0;
    fsMock.existsSync.mockImplementation(() => {
      existsCallCount++;
      // First call: running state check returns true (process exists)
      // After stop (unlink), second call returns false (no state file)
      return existsCallCount === 1;
    });
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        pid: process.pid,
        startedAt: '2026-01-01T00:00:00.000Z',
        command: ['node', 'index.js'],
        openclawUrl: 'http://localhost:18789',
        openclawModel: 'env-model',
        stdoutLog: '/tmp/status-sync/stdout.log',
        stderrLog: '/tmp/status-sync/stderr.log',
      }),
    );
    // kill succeeds for isProcessRunning, then ESRCH after taskkill/SIGTERM
    let killCount = 0;
    killSpy.mockImplementation(() => {
      killCount++;
      if (killCount >= 2) {
        const err = new Error('No such process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
    });
    fsMock.openSync.mockReturnValueOnce(11).mockReturnValueOnce(12);

    const status = startStatusSync({ stateDir: '/tmp/status-sync', force: true });

    expect(status.running).toBe(true);
    expect(childProcessMock.spawn).toHaveBeenCalled();
  });

  it('startStatusSync throws when spawn returns no pid', () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    fsMock.existsSync.mockReturnValue(false);
    childProcessMock.spawn.mockReturnValue({ pid: undefined, unref: vi.fn() });

    expect(() => startStatusSync({ stateDir: '/tmp/status-sync' })).toThrow(
      /Failed to start status-sync child process/,
    );
  });

  it('startStatusSync closes file descriptors even when spawn returns no pid', () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    fsMock.existsSync.mockReturnValue(false);
    // openSync returns fds 11 and 12
    fsMock.openSync.mockReturnValueOnce(11).mockReturnValueOnce(12);
    childProcessMock.spawn.mockReturnValue({ pid: undefined, unref: vi.fn() });

    expect(() => startStatusSync({ stateDir: '/tmp/status-sync' })).toThrow();

    expect(fsMock.closeSync).toHaveBeenCalledWith(11);
    expect(fsMock.closeSync).toHaveBeenCalledWith(12);
  });

  // ── runStatusSyncForeground ───────────────────────────────────────────────

  it('runStatusSyncForeground resolves with exit code 0 on clean exit', async () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';

    const childMock = {
      pid: 9999,
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'exit') {
          // Simulate clean exit with code 0 on next tick
          setImmediate(() => cb(0, null));
        }
        return childMock;
      }),
    };
    childProcessMock.spawn.mockReturnValue(childMock);

    const code = await runStatusSyncForeground({});

    expect(code).toBe(0);
    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('runStatusSyncForeground resolves with exit code 1 when killed by signal', async () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';

    const childMock = {
      pid: 9998,
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'exit') {
          setImmediate(() => cb(null, 'SIGTERM'));
        }
        return childMock;
      }),
    };
    childProcessMock.spawn.mockReturnValue(childMock);

    const code = await runStatusSyncForeground({});

    expect(code).toBe(1);
  });

  it('runStatusSyncForeground resolves with exit code when non-zero', async () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';

    const childMock = {
      pid: 9997,
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'exit') {
          setImmediate(() => cb(2, null));
        }
        return childMock;
      }),
    };
    childProcessMock.spawn.mockReturnValue(childMock);

    const code = await runStatusSyncForeground({});

    expect(code).toBe(2);
  });

  it('runStatusSyncForeground rejects when spawn emits an error', async () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';

    const spawnError = new Error('spawn ENOENT');
    const childMock = {
      pid: 9996,
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'error') {
          setImmediate(() => cb(spawnError));
        }
        return childMock;
      }),
    };
    childProcessMock.spawn.mockReturnValue(childMock);

    await expect(runStatusSyncForeground({})).rejects.toThrow('spawn ENOENT');
  });

  // ── readStateFile edge cases ──────────────────────────────────────────────

  it('getStatusSyncStatus ignores a state file with non-object JSON', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([1, 2, 3]));

    const status = getStatusSyncStatus({ stateDir: '/tmp/status-sync' });

    expect(status.running).toBe(false);
    expect(fsMock.unlinkSync).toHaveBeenCalled();
  });

  it('getStatusSyncStatus ignores a state file with missing required fields', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ pid: 'not-a-number' }));

    const status = getStatusSyncStatus({ stateDir: '/tmp/status-sync' });

    expect(status.running).toBe(false);
    expect(fsMock.unlinkSync).toHaveBeenCalled();
  });

  it('getStatusSyncStatus ignores a state file with invalid JSON', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue('{invalid json}');

    const status = getStatusSyncStatus({ stateDir: '/tmp/status-sync' });

    expect(status.running).toBe(false);
    expect(fsMock.unlinkSync).toHaveBeenCalled();
  });

  it('getStatusSyncStatus uses process.pid so EPERM is treated as running', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        pid: 1234,
        startedAt: '2026-01-01T00:00:00.000Z',
        command: ['node', 'index.js'],
        openclawUrl: 'http://localhost:18789',
        openclawModel: 'home-agent',
        topic: 'test/topic',
        configPath: '/some/config.json',
        profile: null,
        stdoutLog: '/tmp/stdout.log',
        stderrLog: '/tmp/stderr.log',
      }),
    );
    // EPERM means process exists but we don't have permission to signal it
    killSpy.mockImplementation(() => {
      const err = new Error('Operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    const status = getStatusSyncStatus({ stateDir: '/tmp/status-sync' });

    expect(status.running).toBe(true);
    expect(status.pid).toBe(1234);
    expect(status.openclawModel).toBe('home-agent');
    expect(status.topic).toBe('test/topic');
    expect(status.configPath).toBe('/some/config.json');
  });

  // ── buildStatusSyncChildArgs edge cases ──────────────────────────────────

  it('buildStatusSyncChildArgs uses --config when configPath is set', () => {
    getConfigPathMock.mockReturnValue('/custom/config.json');
    getActiveProfileMock.mockReturnValue(undefined);

    const args = buildStatusSyncChildArgs({
      openclawUrl: 'http://localhost:18789',
      openclawModel: 'home-agent',
    });

    expect(args).toContain('--config');
    expect(args).not.toContain('--profile');
    expect(args).not.toContain('--topic');
  });

  it('buildStatusSyncChildArgs omits --profile and --config when neither is set', () => {
    getConfigPathMock.mockReturnValue(undefined);
    getActiveProfileMock.mockReturnValue(undefined);

    const args = buildStatusSyncChildArgs({
      openclawUrl: 'http://localhost:18789',
      openclawModel: 'home-agent',
    });

    expect(args).not.toContain('--config');
    expect(args).not.toContain('--profile');
  });

  it('probeStatusSyncStart rejects with model hint when OpenClaw returns 400', async () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 400,
      ok: false,
      statusText: 'Bad Request',
      text: () => Promise.resolve('model not found'),
    }) as typeof fetch;

    await expect(probeStatusSyncStart({})).rejects.toThrow(
      /HTTP 400[\s\S]*model/i,
    );
  });

  it('probeStatusSyncStart rejects with server error hint when OpenClaw returns 500', async () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve(''),
    }) as typeof fetch;

    await expect(probeStatusSyncStart({})).rejects.toThrow(
      /HTTP 500[\s\S]*server error/i,
    );
  });

  it('probeStatusSyncStart rejects with generic hint when OpenClaw returns 422', async () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 422,
      ok: false,
      statusText: 'Unprocessable Entity',
      text: () => Promise.resolve(''),
    }) as typeof fetch;

    await expect(probeStatusSyncStart({})).rejects.toThrow(
      /HTTP 422[\s\S]*model/i,
    );
  });

  it('probeStatusSyncStart rejects with generic hint for unexpected status', async () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 429,
      ok: false,
      statusText: 'Too Many Requests',
      text: () => Promise.resolve(''),
    }) as typeof fetch;

    await expect(probeStatusSyncStart({})).rejects.toThrow(
      /HTTP 429/,
    );
  });

  it('probeStatusSyncStart throws when no credentials are loaded', async () => {
    process.env.OPENCLAW_TOKEN = 'env-token';
    process.env.OPENCLAW_MODEL = 'env-model';
    // Override: first call in resolveStatusSyncRuntime returns config,
    // but second call in probeStatusSyncStart returns null
    tryLoadConfigMock.mockReturnValueOnce({ token: 't', secret: 's' }).mockReturnValueOnce(null);

    await expect(probeStatusSyncStart({})).rejects.toThrow(
      /No credentials found/,
    );
  });

  it('resolveStatusSyncPaths uses os.homedir when no env override and no explicit stateDir', () => {
    delete process.env.SWITCHBOT_STATUS_SYNC_HOME;
    const paths = resolveStatusSyncPaths();

    expect(paths.stateDir).toMatch(/fake[\\/]home[\\/]\.switchbot[\\/]status-sync$/);
  });
});

function pathFromArgv(): string {
  return path.resolve(process.argv[1]);
}
