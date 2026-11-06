import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resetListCache, updateCacheFromDeviceList } from '../../src/devices/cache.js';
import { deriveSafetyTier, findCatalogEntry } from '../../src/devices/catalog.js';
import { preflightCommandTargets } from '../../src/lib/command-preflight.js';

let tmpDir: string;
let originalArgv: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcli-curtain-lock-alignment-'));
  originalArgv = process.argv;
  process.argv = ['node', 'switchbot'];
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  resetListCache();
});

afterEach(() => {
  process.argv = originalArgv;
  resetListCache();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Curtain 4 and Lock Ultra Max command preflight', () => {
  it('preflights Curtain4 position boundaries and preserves destructive Lock Ultra Max safety after command normalization', () => {
    updateCacheFromDeviceList({
      deviceList: [
        {
          deviceId: 'CURTAIN-4',
          deviceName: 'Curtain 4',
          deviceType: 'Curtain4',
        },
        {
          deviceId: 'LOCK-ULTRA-MAX',
          deviceName: 'Front Door',
          deviceType: 'Smart Lock Ultra Max',
        },
      ],
      infraredRemoteList: [],
    });

    for (const parameter of ['0,ff,0', '0,1,50', '0,0,100']) {
      expect(preflightCommandTargets(['CURTAIN-4'], 'setPosition', parameter, 'command')).toEqual({
        ok: true,
        command: 'setPosition',
        targets: [{ deviceId: 'CURTAIN-4', command: 'setPosition', parameter }],
      });
    }

    for (const parameter of ['0,1,101', '0,2,50', '0,1']) {
      expect(preflightCommandTargets(['CURTAIN-4'], 'setPosition', parameter, 'command')).toMatchObject({
        ok: false,
        deviceId: 'CURTAIN-4',
        kind: 'param-out-of-range',
      });
    }

    expect(preflightCommandTargets(['LOCK-ULTRA-MAX'], 'Unlock', undefined, 'command')).toEqual({
      ok: true,
      command: 'unlock',
      targets: [{ deviceId: 'LOCK-ULTRA-MAX', command: 'unlock', parameter: undefined }],
    });

    const lock = findCatalogEntry('Smart Lock Ultra Max');
    expect(lock).toBeTruthy();
    expect(Array.isArray(lock)).toBe(false);
    if (!lock || Array.isArray(lock)) throw new Error('Lock Ultra Max catalog entry is unavailable');

    const unlock = lock.commands.find((command) => command.command === 'unlock');
    const deadbolt = lock.commands.find((command) => command.command === 'deadbolt');
    expect(unlock).toBeDefined();
    expect(deadbolt).toBeDefined();
    expect(deriveSafetyTier(unlock!, lock)).toBe('destructive');
    expect(deriveSafetyTier(deadbolt!, lock)).toBe('destructive');
  });
});
