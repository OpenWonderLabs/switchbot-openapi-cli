import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { updateCacheFromDeviceList, resetListCache } from '../../src/devices/cache.js';
import { preflightCommandTargets } from '../../src/lib/command-preflight.js';

let tmpDir: string;
let originalArgv: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcli-k11-pro-'));
  originalArgv = process.argv;
  process.argv = ['node', 'switchbot'];
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  resetListCache();
  updateCacheFromDeviceList({
    deviceList: [
      {
        deviceId: 'K11-PRO',
        deviceName: 'K11+ Pro',
        deviceType: 'Robot Vacuum Cleaner K11 Plus Pro',
      },
      {
        deviceId: 'K11-LEGACY',
        deviceName: 'K11+',
        deviceType: 'Robot Vacuum Cleaner K11+',
      },
    ],
    infraredRemoteList: [],
  });
});

afterEach(() => {
  process.argv = originalArgv;
  resetListCache();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('K11+ Pro command preflight', () => {
  it('requires a documented changeParam field for K11+ Pro without changing legacy K11 empty-object behavior', () => {
    expect(preflightCommandTargets(['K11-PRO'], 'changeParam', '{}', 'command')).toMatchObject({
      ok: false,
      deviceId: 'K11-PRO',
      kind: 'param-out-of-range',
    });

    expect(preflightCommandTargets(['K11-PRO'], 'changeParam', '{}', 'command')).toMatchObject({
      ok: false,
      deviceId: 'K11-PRO',
      kind: 'param-out-of-range',
    });

    expect(preflightCommandTargets(['K11-PRO'], 'changeParam', '{"waterLevel":1}', 'command')).toEqual({
      ok: true,
      command: 'changeParam',
      targets: [{ deviceId: 'K11-PRO', command: 'changeParam', parameter: '{"waterLevel":1}' }],
    });

    expect(preflightCommandTargets(['K11-LEGACY'], 'changeParam', '{}', 'command')).toEqual({
      ok: true,
      command: 'changeParam',
      targets: [{ deviceId: 'K11-LEGACY', command: 'changeParam', parameter: '{}' }],
    });
  });

  it('accepts only documented changeParam waterLevel boundaries for K11+ Pro', () => {
    for (const waterLevel of [1, 2]) {
      expect(preflightCommandTargets(['K11-PRO'], 'changeParam', `{"waterLevel":${waterLevel}}`, 'command')).toMatchObject({
        ok: true,
        targets: [{ deviceId: 'K11-PRO', command: 'changeParam', parameter: `{"waterLevel":${waterLevel}}` }],
      });
    }

    for (const parameter of ['{"waterLevel":0}', '{"waterLevel":3}', '{"unsupported":1}']) {
      expect(preflightCommandTargets(['K11-PRO'], 'changeParam', parameter, 'command')).toMatchObject({
        ok: false,
        deviceId: 'K11-PRO',
        kind: 'param-out-of-range',
      });
    }
  });

  it('enforces K11+ Pro setVolume boundaries through command preflight', () => {
    for (const volume of [0, 100]) {
      expect(preflightCommandTargets(['K11-PRO'], 'setVolume', String(volume), 'command')).toMatchObject({
        ok: true,
        targets: [{ deviceId: 'K11-PRO', command: 'setVolume', parameter: String(volume) }],
      });
    }

    for (const volume of [-1, 101]) {
      expect(preflightCommandTargets(['K11-PRO'], 'setVolume', String(volume), 'command')).toMatchObject({
        ok: false,
        deviceId: 'K11-PRO',
        kind: 'param-out-of-range',
      });
    }
  });

  it('allows K11+ Pro sweep and mop startClean commands but rejects invalid parameters', () => {
    for (const parameter of [
      '{"action":"sweep","param":{"fanLevel":1,"times":1}}',
      '{"action":"mop","param":{"fanLevel":4,"times":2639999}}',
    ]) {
      expect(preflightCommandTargets(['K11-PRO'], 'startClean', parameter, 'command')).toMatchObject({
        ok: true,
        targets: [{ deviceId: 'K11-PRO', command: 'startClean', parameter }],
      });
    }

    for (const parameter of [
      '{"action":"sweep","param":{"fanLevel":0}}',
      '{"action":"sweep","param":{"times":0}}',
      '{"action":"sweep","param":{"waterLevel":1}}',
    ]) {
      expect(preflightCommandTargets(['K11-PRO'], 'startClean', parameter, 'command')).toMatchObject({
        ok: false,
        deviceId: 'K11-PRO',
        kind: 'param-out-of-range',
      });
    }
  });
});
