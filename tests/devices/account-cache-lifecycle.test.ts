import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createHmac } from 'node:crypto';
import axios from 'axios';
import { saveConfig } from '../../src/config.js';
import { executeCommand, fetchDeviceList, fetchDeviceStatus } from '../../src/lib/devices.js';
import { loadCache, loadStatusCache, resetListCache, resetStatusCache, setCachedStatus, updateCacheFromDeviceList } from '../../src/devices/cache.js';
import { __resetPrimedCredentials } from '../../src/credentials/prime.js';
import { apiCircuitBreaker, createClient } from '../../src/api/client.js';
import { idempotencyCache } from '../../src/lib/idempotency.js';
import { withRequestContext } from '../../src/lib/request-context.js';

const originalArgv = process.argv;
const originalAdapter = axios.defaults.adapter;
let home: string;
let configPath: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-account-cache-'));
  configPath = path.join(home, 'config.json');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('SWITCHBOT_TOKEN', '');
  vi.stubEnv('SWITCHBOT_SECRET', '');
  vi.stubEnv('PATH', '');
  process.argv = ['node', 'switchbot', '--config', configPath, '--cache', '1h', '--no-quota', '--no-retry'];
  resetListCache();
  resetStatusCache();
  __resetPrimedCredentials();
  idempotencyCache.clear();
  apiCircuitBreaker.reset();
});

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
  process.argv = originalArgv;
  resetListCache();
  resetStatusCache();
  __resetPrimedCredentials();
  idempotencyCache.clear();
  apiCircuitBreaker.reset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function changeAccount(scopeArgs = ['--config', configPath]): void {
  const envFile = path.join(home, 'account-b.env');
  fs.writeFileSync(envFile, 'SWITCHBOT_TOKEN=account-B\nSWITCHBOT_SECRET=secret-B\n');
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', 'src/index.ts', ...scopeArgs, '--json',
    'config', 'set-token', '--from-env-file', envFile,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, PATH: '' },
    encoding: 'utf8', timeout: 20_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error));
}

describe('authenticated dry-run requests', () => {
  it('allows inventory reads while refusing command dispatch', async () => {
    saveConfig('account-A', 'secret-A');
    process.argv.push('--dry-run');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const requests: string[] = [];
    axios.defaults.adapter = async config => {
      requests.push(`${config.method} ${config.url}`);
      return { status: 200, statusText: 'OK', headers: {}, config, data: {
        statusCode: 100, body: { deviceList: [{ deviceId: 'A-DEVICE' }], infraredRemoteList: [] },
      } };
    };
    const client = createClient();
    expect((await client.get('/v1.1/devices')).data.body.deviceList).toEqual([{ deviceId: 'A-DEVICE' }]);
    await expect(client.post('/v1.1/devices/A-DEVICE/commands', { command: 'turnOn' }))
      .rejects.toMatchObject({ name: 'DryRunSignal' });
    expect(requests).toEqual(['get /v1.1/devices']);
  });
});

describe('account changes across processes', () => {
  it('stops serving the old account inventory and status after an external credential command', async () => {
    saveConfig('account-A', 'secret-A');
    const requests: Array<{ url: string | undefined; token: string }> = [];
    axios.defaults.adapter = async (config) => {
      const token = String(config.headers.Authorization);
      requests.push({ url: config.url, token });
      const oldAccount = token === 'account-A';
      const expectedSignature = createHmac('sha256', oldAccount ? 'secret-A' : 'secret-B')
        .update(`${token}${config.headers.t}${config.headers.nonce}`).digest('base64').toUpperCase();
      expect(config.headers.sign).toBe(expectedSignature);
      const body = config.url === '/v1.1/devices' ? {
        deviceList: [{
          deviceId: oldAccount ? 'A-DEVICE' : 'B-DEVICE', deviceName: 'Lamp', deviceType: 'Color Bulb',
          hubDeviceId: '', enableCloudService: true,
        }],
        infraredRemoteList: [],
      } : { power: oldAccount ? 'on' : 'off' };
      return { status: 200, statusText: 'OK', headers: {}, config, data: { statusCode: 100, body } };
    };
    expect((await fetchDeviceList()).deviceList.map(device => device.deviceId)).toEqual(['A-DEVICE']);
    expect(await fetchDeviceStatus('SHARED-DEVICE')).toEqual({ power: 'on' });

    changeAccount();

    expect((await fetchDeviceList()).deviceList.map(device => device.deviceId)).toEqual(['B-DEVICE']);
    expect(await fetchDeviceStatus('SHARED-DEVICE')).toEqual({ power: 'off' });
    expect(requests.slice(2)).toEqual([
      { url: '/v1.1/devices', token: 'account-B' },
      { url: '/v1.1/devices/SHARED-DEVICE/status', token: 'account-B' },
    ]);
  });

  it.each(['named profiles', 'config directories'])('rotates only the selected account across %s', async mode => {
    const scopeArgs = (name: string) => mode === 'named profiles'
      ? ['--profile', name]
      : ['--config', path.join(home, name, 'config.json')];
    const inScope = <T>(name: string, run: () => T): T => {
      process.argv = ['node', 'switchbot', ...scopeArgs(name), '--cache', '1h', '--no-quota', '--no-retry'];
      return withRequestContext({ profile: mode === 'named profiles' ? name : 'default' }, run);
    };
    inScope('alpha', () => saveConfig('alpha-token', 'alpha-secret'));
    inScope('beta', () => saveConfig('beta-token', 'beta-secret'));
    const dispatched: Array<{ account: string; method: string | undefined }> = [];
    axios.defaults.adapter = async config => {
      const account = String(config.headers.Authorization);
      dispatched.push({ account, method: config.method });
      const body = config.url === '/v1.1/devices'
        ? { deviceList: [{ deviceId: 'SHARED', deviceName: account, deviceType: 'Bot' }], infraredRemoteList: [] }
        : { account };
      return { status: 200, statusText: 'OK', headers: {}, config, data: { statusCode: 100, body } };
    };
    const readAccount = (name: string) => inScope(name, async () => ({
      deviceName: (await fetchDeviceList()).deviceList[0].deviceName,
      status: await fetchDeviceStatus('SHARED'),
      command: await executeCommand('SHARED', 'turnOn', 'default', 'command', undefined, { idempotencyKey: 'shared-key' }),
    }));

    expect(await readAccount('alpha')).toEqual({
      deviceName: 'alpha-token', status: { account: 'alpha-token' }, command: { account: 'alpha-token' },
    });
    expect(await readAccount('beta')).toEqual({
      deviceName: 'beta-token', status: { account: 'beta-token' }, command: { account: 'beta-token' },
    });
    changeAccount(scopeArgs('alpha'));
    dispatched.length = 0;

    expect(await readAccount('beta')).toEqual({
      deviceName: 'beta-token', status: { account: 'beta-token' }, command: { account: 'beta-token', replayed: true },
    });
    expect(dispatched).toEqual([]);
    expect(await readAccount('alpha')).toEqual({
      deviceName: 'account-B', status: { account: 'account-B' }, command: { account: 'account-B' },
    });
    expect(dispatched).toEqual([
      { account: 'account-B', method: 'get' }, { account: 'account-B', method: 'get' }, { account: 'account-B', method: 'post' },
    ]);
  });

  it.each(['inventory', 'status', 'uncached status'])('rejects an old-account %s response after credential replacement', async kind => {
    saveConfig('account-A', 'secret-A');
    if (kind === 'uncached status') process.argv.push('--no-cache');
    const client = axios.create({
      adapter: async config => {
        changeAccount();
        const body = kind === 'inventory'
          ? { deviceList: [{ deviceId: 'OLD', deviceName: 'Old account', deviceType: 'Bot' }], infraredRemoteList: [] }
          : { power: 'on' };
        return { status: 200, statusText: 'OK', headers: {}, config, data: { body } };
      },
    });

    const pending = kind === 'inventory' ? fetchDeviceList(client) : fetchDeviceStatus('SHARED', client);
    await expect(pending).rejects.toMatchObject({ name: 'CredentialScopeChangedError' });
    resetListCache();
    resetStatusCache();
    expect(loadCache()).toBeNull();
    expect(loadStatusCache()).toEqual({ entries: {} });
  });

  it('does not replay the previous account command result for the same idempotency key', async () => {
    saveConfig('account-A', 'secret-A');
    const dispatched: string[] = [];
    axios.defaults.adapter = async config => {
      const account = String(config.headers.Authorization);
      dispatched.push(account);
      return { status: 200, statusText: 'OK', headers: {}, config, data: { statusCode: 100, body: { account } } };
    };
    const command = () => executeCommand('SHARED', 'turnOn', 'default', 'command', undefined, { idempotencyKey: 'same-key' });
    expect(await command()).toEqual({ account: 'account-A' });
    changeAccount();
    expect(await command()).toEqual({ account: 'account-B' });
    expect(await command()).toEqual({ account: 'account-B', replayed: true });
    expect(dispatched).toEqual(['account-A', 'account-B']);
  });

  it('refuses a retained client instead of silently sending its operation to either account', async () => {
    saveConfig('account-A', 'secret-A');
    const dispatched: string[] = [];
    axios.defaults.adapter = async config => {
      dispatched.push(String(config.headers.Authorization));
      return { status: 200, statusText: 'OK', headers: {}, config, data: { statusCode: 100, body: {} } };
    };
    const client = createClient();
    changeAccount();
    await expect(client.post('/v1.1/devices/SHARED/commands', { command: 'turnOn' }))
      .rejects.toMatchObject({ name: 'CredentialScopeChangedError' });
    expect(dispatched).toEqual([]);
    await createClient().post('/v1.1/devices/SHARED/commands', { command: 'turnOn' });
    expect(dispatched).toEqual(['account-B']);
  });

  it('does not retry a rate-limited POST after the account changes', async () => {
    saveConfig('account-A', 'secret-A');
    process.argv = process.argv.filter(arg => arg !== '--no-retry');
    process.argv.push('--retry-on-429', '1');
    const dispatched: string[] = [];
    axios.defaults.adapter = async config => {
      dispatched.push(String(config.headers.Authorization));
      if (dispatched.length === 1) {
        changeAccount();
        throw new axios.AxiosError('Rate limited', 'ERR_BAD_REQUEST', config, undefined, {
          status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '0' }, config, data: {},
        });
      }
      return { status: 200, statusText: 'OK', headers: {}, config, data: { statusCode: 100, body: {} } };
    };
    await expect(createClient().post('/v1.1/devices/SHARED/commands', { command: 'turnOn' }))
      .rejects.toMatchObject({ name: 'CredentialScopeChangedError' });
    expect(dispatched).toEqual(['account-A']);
  });

  it('does not let an old command completion overwrite the new account replay result', async () => {
    saveConfig('account-A', 'secret-A');
    const gate = new EventEmitter();
    const entered = once(gate, 'started');
    const dispatched: string[] = [];
    axios.defaults.adapter = async config => {
      const account = String(config.headers.Authorization);
      dispatched.push(account);
      if (account === 'account-A') {
        const waiting = once(gate, 'release');
        gate.emit('started');
        await waiting;
      }
      return { status: 200, statusText: 'OK', headers: {}, config, data: { statusCode: 100, body: { account } } };
    };
    const command = () => executeCommand('SHARED', 'turnOn', 'default', 'command', undefined, { idempotencyKey: 'same-key' });
    const old = command();
    await entered;
    changeAccount();
    expect(await command()).toEqual({ account: 'account-B' });
    gate.emit('release');
    expect(await old).toEqual({ account: 'account-A' });
    expect(await command()).toEqual({ account: 'account-B', replayed: true });
    expect(dispatched).toEqual(['account-A', 'account-B']);
  });

  it.each(['inventory', 'status'])('keeps a complete %s snapshot readable during replacement', kind => {
    const writeVersion = (version: string) => {
      if (kind === 'inventory') updateCacheFromDeviceList({
        deviceList: [{ deviceId: version, deviceName: version, deviceType: 'Bot' }], infraredRemoteList: [],
      });
      else setCachedStatus('SHARED', { power: version });
    };
    const readVersion = () => {
      resetListCache();
      resetStatusCache();
      return kind === 'inventory' ? loadCache() : loadStatusCache();
    };
    writeVersion('old');
    const previous = structuredClone(readVersion());
    const originalWrite = fs.writeFileSync;
    let duringWrite: unknown;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      // Hold the writer at a partial document while a cold reader opens the cache.
      originalWrite(file, String(data).slice(0, 12), options);
      duringWrite = structuredClone(readVersion());
      originalWrite(file, data, typeof options === 'object' ? { ...options, flag: 'w' } : { flag: 'w' });
    });
    writeVersion('new');

    expect(duringWrite).toEqual(previous);
    const committed = readVersion();
    if (kind === 'inventory') expect(committed).toMatchObject({ devices: { new: { name: 'new' } } });
    else expect(committed).toMatchObject({ entries: { SHARED: { body: { power: 'new' } } } });
  });

  it('ignores old disk snapshots even if a stale writer restores them after rotation', () => {
    saveConfig('account-A', 'secret-A');
    updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'OLD', deviceName: 'Old device', deviceType: 'Bot' }], infraredRemoteList: [],
    });
    setCachedStatus('OLD', { power: 'on' });
    const files = ['devices.json', 'status.json'].map(name => path.join(home, name));
    const obsolete = files.map(file => fs.readFileSync(file, 'utf8'));
    changeAccount();
    files.forEach((file, index) => fs.writeFileSync(file, obsolete[index]));
    resetListCache();
    resetStatusCache();
    expect(loadCache()).toBeNull();
    expect(loadStatusCache()).toEqual({ entries: {} });
  });

  it.each(['initial', 'retry'])('rejects an account replacement during %s request credential resolution', async phase => {
    saveConfig('account-A', 'secret-A');
    process.argv = process.argv.filter(arg => arg !== '--no-retry');
    process.argv.push('--retry-on-429', '1');
    let rotateOnRead = phase === 'initial';
    const dispatched: string[] = [];
    axios.defaults.adapter = async config => {
      dispatched.push(String(config.headers.Authorization));
      if (phase === 'retry' && dispatched.length === 1) {
        rotateOnRead = true;
        throw new axios.AxiosError('Rate limited', 'ERR_BAD_REQUEST', config, undefined, {
          status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '0' }, config, data: {},
        });
      }
      return { status: 200, statusText: 'OK', headers: {}, config, data: { statusCode: 100, body: {} } };
    };
    const client = createClient();
    const originalRead = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
      if (String(file) === configPath && rotateOnRead) {
        rotateOnRead = false;
        changeAccount();
      }
      return originalRead(file, options);
    });

    await expect(client.post('/v1.1/devices/SHARED/commands', { command: 'turnOn' }))
      .rejects.toMatchObject({ name: 'CredentialScopeChangedError' });
    expect(dispatched).toEqual(phase === 'initial' ? [] : ['account-A']);
  });
});
