import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { registerDevicesCommand } from '../../src/commands/devices.js';
import { resetListCache, updateCacheFromDeviceList } from '../../src/devices/cache.js';
import { withRequestContext } from '../../src/lib/request-context.js';
import { runCli } from '../helpers/cli.js';

const originalAdapter = axios.defaults.adapter;
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-frame-guard-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  vi.stubEnv('SWITCHBOT_TOKEN', 'test-token');
  vi.stubEnv('SWITCHBOT_SECRET', 'test-secret');
  vi.stubEnv('SWITCHBOT_ALLOW_DIRECT_DESTRUCTIVE', '');
  resetListCache();
});

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
  resetListCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Art Frame deletion authorization', () => {
  it.each([
    { deviceType: 'AI Art Frame', profile: undefined, selector: 'newest', kind: 'guard' },
    { deviceType: 'AI Art Frame 2', profile: 'dev', selector: 'all', kind: 'usage' },
  ])('enforces direct deletion constraints for $deviceType', async ({ deviceType, profile, selector, kind }) => {
    const adapter = vi.fn(async () => { throw new Error('Unexpected cloud request'); });
    axios.defaults.adapter = adapter;
    withRequestContext({ profile }, () => updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'FRAME', deviceName: 'Gallery', deviceType }], infraredRemoteList: [],
    }));
    const args = ['--json', '--no-quota', ...(profile ? ['--profile', profile] : []),
      'devices', 'command', 'FRAME', 'DeleteImage', selector, '--yes', '--skip-param-validation'];
    const result = await runCli(registerDevicesCommand, args);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout.join('\n')).error).toMatchObject({
      kind, context: { command: 'deleteImage', deviceType, ...(kind === 'guard' ? { requiredWorkflow: 'plan-approval' } : {}) },
    });
    expect(adapter).not.toHaveBeenCalled();
  });

  it('blocks a cold batch deletion with only controlType in inventory', async () => {
    const methods: string[] = [];
    axios.defaults.adapter = async config => {
      methods.push(config.method!);
      const body = config.method === 'get' ? {
        deviceList: [{ deviceId: 'FRAME', deviceName: 'Gallery', controlType: 'AI Art Frame 2' }], infraredRemoteList: [],
      } : {};
      return { status: 200, statusText: 'OK', config, headers: {}, data: { statusCode: 100, body } };
    };
    const result = await runCli(registerDevicesCommand, [
      '--json', '--no-quota', 'devices', 'batch', 'DeleteImage', 'oldest', '--ids', 'FRAME', '--yes',
    ]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout.join('\n')).error).toMatchObject({
      kind: 'guard', context: { command: 'deleteImage', requiredWorkflow: 'plan-approval' },
    });
    expect(methods).toEqual(['get']);
  });
});
