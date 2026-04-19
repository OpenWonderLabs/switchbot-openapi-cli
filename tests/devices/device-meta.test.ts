import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadDeviceMeta,
  saveDeviceMeta,
  getDeviceMeta,
  setDeviceMeta,
  clearDeviceMeta,
} from '../../src/devices/device-meta.js';

vi.mock('../../src/utils/flags.js', () => ({ getConfigPath: () => undefined }));

const TMP = path.join(os.tmpdir(), `switchbot-meta-test-${process.pid}`);
const META_FILE = path.join(TMP, '.switchbot', 'device-meta.json');

function patchHome() {
  const orig = os.homedir;
  vi.spyOn(os, 'homedir').mockReturnValue(TMP);
  return () => { (os.homedir as unknown as { mockRestore: () => void }).mockRestore = orig; };
}

describe('device-meta.ts', () => {
  beforeEach(() => {
    if (fs.existsSync(META_FILE)) fs.rmSync(META_FILE);
    if (fs.existsSync(path.dirname(META_FILE))) {
      fs.rmSync(path.dirname(META_FILE), { recursive: true });
    }
    patchHome();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(path.dirname(META_FILE))) {
      fs.rmSync(path.dirname(META_FILE), { recursive: true });
    }
  });

  it('loadDeviceMeta returns empty structure when file does not exist', () => {
    const meta = loadDeviceMeta();
    expect(meta).toEqual({ version: '1', devices: {} });
  });

  it('saveDeviceMeta then loadDeviceMeta round-trips', () => {
    saveDeviceMeta({ version: '1', devices: { ABC: { alias: 'My Device', hidden: false } } });
    const loaded = loadDeviceMeta();
    expect(loaded.devices['ABC']).toEqual({ alias: 'My Device', hidden: false });
  });

  it('getDeviceMeta returns null for unknown id', () => {
    expect(getDeviceMeta('UNKNOWN')).toBeNull();
  });

  it('setDeviceMeta creates and merges entry', () => {
    setDeviceMeta('DEV1', { alias: 'Lamp', hidden: false });
    setDeviceMeta('DEV1', { hidden: true });
    const entry = getDeviceMeta('DEV1');
    expect(entry?.alias).toBe('Lamp');
    expect(entry?.hidden).toBe(true);
  });

  it('clearDeviceMeta removes entry', () => {
    setDeviceMeta('DEV2', { alias: 'Fan' });
    clearDeviceMeta('DEV2');
    expect(getDeviceMeta('DEV2')).toBeNull();
  });

  it('loadDeviceMeta returns empty on malformed JSON', () => {
    fs.mkdirSync(path.dirname(META_FILE), { recursive: true });
    fs.writeFileSync(META_FILE, 'not json');
    expect(loadDeviceMeta()).toEqual({ version: '1', devices: {} });
  });
});
