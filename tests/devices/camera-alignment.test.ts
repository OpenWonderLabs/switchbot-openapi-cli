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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcli-camera-alignment-'));
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

describe('camera capability alignment', () => {
  it('supports Solar motion detection controls safely while keeping Outdoor Pan/Tilt Cam 3K read-only', () => {
    updateCacheFromDeviceList({
      deviceList: [
        {
          deviceId: 'SOLAR-CAMERA',
          deviceName: 'Solar camera',
          deviceType: 'Solar Pan/Tilt Cam 2K',
        },
        {
          deviceId: 'OUTDOOR-CAMERA',
          deviceName: 'Outdoor camera',
          deviceType: 'Outdoor Pan/Tilt Cam 3K',
        },
      ],
      infraredRemoteList: [],
    });

    const solar = findCatalogEntry('Solar Pan/Tilt Cam 2K');
    expect(solar).toBeTruthy();
    expect(Array.isArray(solar)).toBe(false);
    if (!solar || Array.isArray(solar)) throw new Error('Solar camera catalog entry is unavailable');

    expect(preflightCommandTargets(['SOLAR-CAMERA'], 'enableMotionDetection', undefined, 'command')).toEqual({
      ok: true,
      command: 'enableMotionDetection',
      targets: [{ deviceId: 'SOLAR-CAMERA', command: 'enableMotionDetection', parameter: undefined }],
    });
    const disableMotionDetection = solar.commands.find((command) => command.command === 'disableMotionDetection');
    expect(disableMotionDetection).toBeDefined();
    expect(deriveSafetyTier(disableMotionDetection!, solar)).toBe('destructive');

    const outdoor = findCatalogEntry('Outdoor Pan/Tilt Cam 3K');
    expect(outdoor).toBeTruthy();
    expect(Array.isArray(outdoor)).toBe(false);
    if (!outdoor || Array.isArray(outdoor)) throw new Error('Outdoor camera catalog entry is unavailable');
    expect(outdoor.readOnly).toBe(true);
    expect(outdoor.commands).toEqual([]);
    expect(preflightCommandTargets(['OUTDOOR-CAMERA'], 'turnOn', undefined, 'command')).toMatchObject({
      ok: false,
      deviceId: 'OUTDOOR-CAMERA',
      kind: 'read-only-device',
    });
  });
});
