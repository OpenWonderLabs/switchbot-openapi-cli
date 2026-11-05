import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resetListCache, updateCacheFromDeviceList } from '../../src/devices/cache.js';
import { findCatalogEntry } from '../../src/devices/catalog.js';
import { preparePlanTargets } from '../../src/lib/plan-preflight.js';

let tmpDir: string;
let originalArgv: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcli-art-frame-object-'));
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

describe('AI Art Frame upload plan preflight', () => {
  it('converts JSON-string uploads to wire objects and rejects a null second image source before dispatch', async () => {
    updateCacheFromDeviceList({
      deviceList: [
        {
          deviceId: 'ART-FRAME',
          deviceName: 'Gallery',
          deviceType: 'AI Art Frame',
        },
      ],
      infraredRemoteList: [],
    });

    await expect(preparePlanTargets([
      {
        type: 'command',
        deviceId: 'ART-FRAME',
        command: 'uploadImage',
        parameter: '{"imageUrl":"https://example.test/a.jpg"}',
      },
    ])).resolves.toEqual({
      ok: true,
      commands: [
        {
          stepIndex: 0,
          deviceId: 'ART-FRAME',
          deviceType: 'AI Art Frame',
          command: 'uploadImage',
          parameter: { imageUrl: 'https://example.test/a.jpg' },
          commandType: 'command',
          destructive: false,
        },
      ],
    });

    await expect(preparePlanTargets([
      {
        type: 'command',
        deviceId: 'ART-FRAME',
        command: 'uploadImage',
        parameter: { imageUrl: 'https://example.test/a.jpg', imageBase64: null },
      },
    ])).resolves.toMatchObject({
      ok: false,
      stepIndex: 0,
      deviceId: 'ART-FRAME',
      kind: 'parameter-validation',
    });
  });

  it('discovers Luma-only online status and prepares bare and JPEG data-URI base64 upload objects', async () => {
    updateCacheFromDeviceList({
      deviceList: [
        {
          deviceId: 'ART-FRAME-LUMA',
          deviceName: 'Luma Gallery',
          deviceType: 'AI Art Frame Luma',
        },
      ],
      infraredRemoteList: [],
    });

    const luma = findCatalogEntry('AI Art Frame Luma');
    const original = findCatalogEntry('AI Art Frame');
    expect(luma).toBeTruthy();
    expect(Array.isArray(luma)).toBe(false);
    expect(original).toBeTruthy();
    expect(Array.isArray(original)).toBe(false);
    if (!luma || Array.isArray(luma) || !original || Array.isArray(original)) {
      throw new Error('AI Art Frame catalog entries are unavailable');
    }
    expect(luma.statusFields).toContain('onlineStatus');
    expect(original.statusFields).not.toContain('onlineStatus');

    await expect(preparePlanTargets([
      {
        type: 'command',
        deviceId: 'ART-FRAME-LUMA',
        command: 'uploadImage',
        parameter: { imageBase64: 'QUJDRA==' },
      },
      {
        type: 'command',
        deviceId: 'ART-FRAME-LUMA',
        command: 'uploadImage',
        parameter: '{"imageBase64":"data:image/jpeg;base64,/9j/4AAQ"}',
      },
    ])).resolves.toEqual({
      ok: true,
      commands: [
        {
          stepIndex: 0,
          deviceId: 'ART-FRAME-LUMA',
          deviceType: 'AI Art Frame Luma',
          command: 'uploadImage',
          parameter: { imageBase64: 'QUJDRA==' },
          commandType: 'command',
          destructive: false,
        },
        {
          stepIndex: 1,
          deviceId: 'ART-FRAME-LUMA',
          deviceType: 'AI Art Frame Luma',
          command: 'uploadImage',
          parameter: { imageBase64: 'data:image/jpeg;base64,/9j/4AAQ' },
          commandType: 'command',
          destructive: false,
        },
      ],
    });
  });
});
