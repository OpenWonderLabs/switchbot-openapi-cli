import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import axios from 'axios';
import { apiCircuitBreaker, createClient } from '../../src/api/client.js';
import { publishCredentialRevision, readCredentialScope } from '../../src/credentials/scope.js';
import { createFileBackend } from '../../src/credentials/backends/file.js';
import { loadConfig, saveConfig, tryLoadConfig } from '../../src/config.js';
import {
  primeCredentials,
  getPrimedCredentials,
  clearPrimedCredentials,
  __resetPrimedCredentials,
} from '../../src/credentials/prime.js';

const selectMock = vi.fn();
const originalArgv = process.argv;
const originalAdapter = axios.defaults.adapter;
let home: string;

vi.mock('../../src/credentials/keychain.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/credentials/keychain.js')>(
    '../../src/credentials/keychain.js',
  );
  return {
    ...actual,
    selectCredentialStore: (...args: unknown[]) => selectMock(...args),
  };
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-credential-prime-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  process.argv = ['node', 'switchbot'];
  selectMock.mockReset();
  vi.stubEnv('SWITCHBOT_TOKEN', undefined);
  vi.stubEnv('SWITCHBOT_SECRET', undefined);
  __resetPrimedCredentials();
  apiCircuitBreaker.reset();
});

afterEach(() => {
  process.argv = originalArgv;
  axios.defaults.adapter = originalAdapter;
  apiCircuitBreaker.reset();
  __resetPrimedCredentials();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function changeAccount(): void {
  const envFile = path.join(home, 'account-b.env');
  fs.writeFileSync(envFile, 'SWITCHBOT_TOKEN=account-B\nSWITCHBOT_SECRET=secret-B\n');
  const changed = spawnSync(process.execPath, [
    '--import', 'tsx', 'src/index.ts', '--json', 'config', 'set-token', '--from-env-file', envFile,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, PATH: '', SWITCHBOT_TOKEN: '', SWITCHBOT_SECRET: '' },
    encoding: 'utf8', timeout: 20_000,
  });
  if (changed.status !== 0) throw new Error(changed.stderr || changed.stdout);
}

describe('primeCredentials', () => {
  it('refreshes within the TTL after another process replaces credentials', async () => {
    saveConfig('account-A', 'secret-A');
    selectMock.mockResolvedValue(createFileBackend());
    await primeCredentials('default');
    expect(loadConfig().token).toBe('account-A');

    changeAccount();

    await primeCredentials('default');
    expect(loadConfig().token).toBe('account-B');
  });

  it('rejects an obsolete keychain lookup without poisoning the replacement account', async () => {
    saveConfig('account-A', 'secret-A');
    const gate = new EventEmitter();
    const entered = once(gate, 'started');
    selectMock.mockResolvedValueOnce({
      ...createFileBackend(),
      get: async () => {
        const waiting = once(gate, 'release');
        gate.emit('started');
        await waiting;
        return { token: 'account-A', secret: 'secret-A' };
      },
    });
    const obsolete = primeCredentials('default').then(() => null, error => error);
    await entered;
    changeAccount();
    selectMock.mockResolvedValue(createFileBackend());
    const replacement = primeCredentials('default');
    gate.emit('release');

    expect(await obsolete).toMatchObject({ name: 'CredentialScopeChangedError' });
    await replacement;
    expect(loadConfig().token).toBe('account-B');
  });

  it.each(['throws', 'missing', 'file fallback'])('does not dispatch old file credentials when a replacement keychain %s', async failure => {
    saveConfig('account-A', 'secret-A');
    publishCredentialRevision(readCredentialScope(), true);
    if (failure === 'throws') selectMock.mockRejectedValue(new Error('keychain locked'));
    else if (failure === 'missing') selectMock.mockResolvedValue({ ...createFileBackend(), name: 'keychain', get: async () => null });
    else selectMock.mockResolvedValue(createFileBackend());
    const dispatched: string[] = [];
    axios.defaults.adapter = async config => {
      const account = String(config.headers.Authorization);
      dispatched.push(account);
      return { status: 200, statusText: 'OK', headers: {}, config, data: { statusCode: 100, body: { account } } };
    };

    await expect(createClient().get('/v1.1/devices')).rejects.toThrow(/credential/i);
    expect(dispatched).toEqual([]);
    selectMock.mockResolvedValue({
      ...createFileBackend(), name: 'keychain',
      get: async () => ({ token: 'account-B', secret: 'secret-B' }),
    });
    expect((await createClient().get('/v1.1/devices')).data.body).toEqual({ account: 'account-B' });
    expect(dispatched).toEqual(['account-B']);
  });

  it('does not let synchronous credential consumers fall back to an obsolete file after keychain replacement', () => {
    saveConfig('account-A', 'secret-A');
    publishCredentialRevision(readCredentialScope(), true);
    expect(() => loadConfig()).toThrow(/credential/i);
    expect(tryLoadConfig()).toBeNull();
  });

  it('keeps offline commands and credential repair available when the replacement keychain is unavailable', () => {
    saveConfig('account-A', 'secret-A');
    publishCredentialRevision(readCredentialScope(), true);
    const offline = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', '--json', 'catalog', 'show', 'Bot'], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, PATH: '', SWITCHBOT_TOKEN: '', SWITCHBOT_SECRET: '' },
      encoding: 'utf8', timeout: 20_000,
    });
    expect(offline.status, offline.stderr).toBe(0);
    expect(JSON.parse(offline.stdout)).toMatchObject({ schemaVersion: expect.any(String), data: expect.anything() });

    changeAccount();
    expect(loadConfig().token).toBe('account-B');
  });

  it('does not wait for a stalled keychain when complete env credentials are present', async () => {
    vi.useFakeTimers();
    vi.stubEnv('SWITCHBOT_TOKEN', 'env-token');
    vi.stubEnv('SWITCHBOT_SECRET', 'env-secret');
    selectMock.mockResolvedValue({
      name: 'keychain',
      get: () => new Promise(() => {}),
    });

    const outcome = Promise.race([
      primeCredentials('default').then(() => 'ready'),
      new Promise((resolve) => setTimeout(resolve, 10_000, 'timed-out')),
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toBe('ready');
  });

  it('caches a successful keychain read and makes it accessible via getPrimedCredentials', async () => {
    const get = vi.fn().mockResolvedValue({ token: 'T', secret: 'S' });
    selectMock.mockResolvedValue({ name: 'keychain', get } as any);

    await primeCredentials('default');
    expect(getPrimedCredentials('default')).toEqual({ token: 'T', secret: 'S' });
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('default');
  });

  it('returns null from getPrimedCredentials when the keychain lookup returned null', async () => {
    const get = vi.fn().mockResolvedValue(null);
    selectMock.mockResolvedValue({ name: 'file', get } as any);

    await primeCredentials('default');
    expect(getPrimedCredentials('default')).toBeNull();
  });

  it('returns null for a profile different from the primed one', async () => {
    const get = vi.fn().mockResolvedValue({ token: 'T', secret: 'S' });
    selectMock.mockResolvedValue({ name: 'keychain', get } as any);

    await primeCredentials('default');
    expect(getPrimedCredentials('work')).toBeNull();
  });

  it("shares one keychain lookup for concurrent refreshes of a profile", async () => {
    let resolveGet!: (creds: { token: string; secret: string }) => void;
    const pending = new Promise<{ token: string; secret: string }>((resolve) => { resolveGet = resolve; });
    const get = vi.fn().mockReturnValue(pending);
    selectMock.mockResolvedValue({ name: "keychain", get } as any);

    const first = primeCredentials("default");
    const second = primeCredentials("default");
    await Promise.resolve();
    await Promise.resolve();

    expect(get).toHaveBeenCalledOnce();
    resolveGet({ token: "fresh-token", secret: "fresh-secret" });
    await Promise.all([first, second]);

    expect(getPrimedCredentials("default")).toEqual({ token: "fresh-token", secret: "fresh-secret" });
  });

  it('repriming the same profile short-circuits (no extra store selection)', async () => {
    const get = vi.fn().mockResolvedValue(null);
    selectMock.mockResolvedValue({ name: 'file', get } as any);

    await primeCredentials('default');
    await primeCredentials('default');
    await primeCredentials('default');
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('priming a different profile keeps both entries independently cached', async () => {
    const getA = vi.fn().mockResolvedValue({ token: 'TA', secret: 'SA' });
    const getB = vi.fn().mockResolvedValue({ token: 'TB', secret: 'SB' });
    selectMock
      .mockResolvedValueOnce({ name: 'keychain', get: getA } as any)
      .mockResolvedValueOnce({ name: 'keychain', get: getB } as any);

    await primeCredentials('a');
    expect(getPrimedCredentials('a')).toEqual({ token: 'TA', secret: 'SA' });

    await primeCredentials('b');
    expect(getPrimedCredentials('b')).toEqual({ token: 'TB', secret: 'SB' });
    expect(getPrimedCredentials('a')).toEqual({ token: 'TA', secret: 'SA' });
  });

  it('swallows errors from selectCredentialStore', async () => {
    selectMock.mockRejectedValue(new Error('explode'));
    await expect(primeCredentials('default')).resolves.toBeUndefined();
    expect(getPrimedCredentials('default')).toBeNull();
  });

  it('swallows errors from the backend get()', async () => {
    const get = vi.fn().mockRejectedValue(new Error('timeout'));
    selectMock.mockResolvedValue({ name: 'keychain', get } as any);

    await expect(primeCredentials('default')).resolves.toBeUndefined();
    expect(getPrimedCredentials('default')).toBeNull();
  });

  it('clearPrimedCredentials() clears the in-memory cache immediately', async () => {
    const get = vi.fn().mockResolvedValue({ token: 'T', secret: 'S' });
    selectMock.mockResolvedValue({ name: 'keychain', get } as any);

    await primeCredentials('default');
    expect(getPrimedCredentials('default')).not.toBeNull();

    clearPrimedCredentials();
    expect(getPrimedCredentials('default')).toBeNull();
  });
});

describe('clearPrimedCredentials() race — no-arg path vs in-flight prime', () => {
  it('discards in-flight result when no-arg clear fires before store.get() resolves', async () => {
    // Set up a deferred resolve so we can fire clearPrimedCredentials()
    // while primeCredentials() is suspended at `await store.get()`.
    let resolveGet!: (v: { token: string; secret: string } | null) => void;
    const getDeferred = new Promise<{ token: string; secret: string } | null>(
      (res) => { resolveGet = res; }
    );
    const get = vi.fn().mockReturnValue(getDeferred);
    selectMock.mockResolvedValue({ name: 'keychain', get } as any);

    // Start prime without await — it suspends at store.get()
    const primePromise = primeCredentials('p1');

    // Fire the no-arg clear while p1 is NOT yet in `caches`
    clearPrimedCredentials();

    // Now let store.get() resolve with fresh credentials
    resolveGet({ token: 'STALE', secret: 'STALE' });
    await primePromise;

    // The generation was bumped, so the resolve must have been discarded
    expect(getPrimedCredentials('p1')).toBeNull();
  });

  it('no-arg clear after prime completes evicts the cached entry', async () => {
    const get = vi.fn().mockResolvedValue({ token: 'T', secret: 'S' });
    selectMock.mockResolvedValue({ name: 'keychain', get } as any);

    await primeCredentials('p2');
    expect(getPrimedCredentials('p2')).not.toBeNull();

    clearPrimedCredentials(); // no arg — should evict p2
    expect(getPrimedCredentials('p2')).toBeNull();
  });

  it('profile-specific clear does not evict other profiles', async () => {
    const getA = vi.fn().mockResolvedValue({ token: 'TA', secret: 'SA' });
    const getB = vi.fn().mockResolvedValue({ token: 'TB', secret: 'SB' });
    selectMock
      .mockResolvedValueOnce({ name: 'keychain', get: getA } as any)
      .mockResolvedValueOnce({ name: 'keychain', get: getB } as any);

    await primeCredentials('a');
    await primeCredentials('b');

    clearPrimedCredentials('a');
    expect(getPrimedCredentials('a')).toBeNull();
    expect(getPrimedCredentials('b')).toEqual({ token: 'TB', secret: 'SB' });
  });
});
