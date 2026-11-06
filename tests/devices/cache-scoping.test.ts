/**
 * Tests for per-profile cache scoping (Bug #37).
 *
 * Each test:
 *  - Redirects os.homedir() to a fresh tmpdir so no real ~/.switchbot is touched.
 *  - Sets/clears the active profile via process.argv or withRequestContext.
 *  - Verifies profile isolation in memory and after reloading from disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import {
  loadCache,
  updateCacheFromDeviceList,
  setCachedStatus,
  resetListCache,
  getCachedStatus,
  clearCache,
  clearStatusCache,
  resetStatusCache,
} from '../../src/devices/cache.js';
import { withRequestContext } from '../../src/lib/request-context.js';
import { readCredentialScope } from '../../src/credentials/scope.js';

const originalArgv = process.argv;
let tmpDir: string;

const sampleBody = {
  deviceList: [{ deviceId: 'DEV-1', deviceName: 'Bot', deviceType: 'Bot' }],
  infraredRemoteList: [],
};

function sha8(profile: string): string {
  return createHash('sha256').update(profile).digest('hex').slice(0, 8);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcli-scoping-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  // Start each test with no profile flag and clean argv
  process.argv = ['node', 'switchbot'];
  resetListCache();
  resetStatusCache();
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  resetListCache();
  resetStatusCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── a. No profile (default) ─────────────────────────────────────────────────

describe('cache scoping — no profile (legacy path)', () => {
  it('writes devices.json to the legacy ~/.switchbot/devices.json path', () => {
    // No profile set — process.argv has no --profile flag
    updateCacheFromDeviceList(sampleBody);

    const legacy = path.join(tmpDir, '.switchbot', 'devices.json');
    expect(fs.existsSync(legacy)).toBe(true);

    // The scoped sub-directory must NOT exist
    const scopedDir = path.join(tmpDir, '.switchbot', 'cache');
    expect(fs.existsSync(scopedDir)).toBe(false);
  });

  it('shares inventory, status and clearing with explicit default', () => {
    updateCacheFromDeviceList(sampleBody);
    setCachedStatus('DEV-1', { power: 'on' });

    withRequestContext({ profile: 'default' }, () => {
      expect(loadCache()?.devices['DEV-1']?.name).toBe('Bot');
      expect(getCachedStatus('DEV-1', 60_000)).toEqual({ power: 'on' });
      clearCache();
      clearStatusCache();
    });

    expect(loadCache()).toBeNull();
    expect(getCachedStatus('DEV-1', 60_000)).toBeNull();
  });

  it.each(['default', 'profile-55372'])('does not restore obsolete short-hash caches for %s', activeProfile => {
    const obsolete = path.join(tmpDir, '.switchbot', 'cache', sha8(activeProfile));
    const now = new Date().toISOString();
    fs.mkdirSync(obsolete, { recursive: true });
    fs.writeFileSync(path.join(obsolete, 'devices.json'), JSON.stringify({
      lastUpdated: now, devices: { OLD: { type: 'Bot', name: 'Old account', category: 'physical' } },
    }));
    fs.writeFileSync(path.join(obsolete, 'status.json'), JSON.stringify({
      entries: { OLD: { fetchedAt: now, body: { power: 'on' } } },
    }));
    withRequestContext({ profile: activeProfile }, () => {
      expect(loadCache()).toBeNull();
      expect(getCachedStatus('OLD', 60_000)).toBeNull();
      updateCacheFromDeviceList(sampleBody);
      setCachedStatus('DEV-1', { power: 'off' });
      expect(loadCache()?.devices).toEqual({
        'DEV-1': { type: 'Bot', typeSource: 'deviceType', name: 'Bot', category: 'physical' },
      });
      expect(getCachedStatus('OLD', 60_000)).toBeNull();
      expect(getCachedStatus('DEV-1', 60_000)).toEqual({ power: 'off' });
      clearCache();
      clearStatusCache();
    });
    resetListCache();
    resetStatusCache();

    for (const profile of activeProfile === 'default' ? [undefined, 'default'] : [activeProfile]) {
      withRequestContext({ profile }, () => {
        expect(loadCache()).toBeNull();
        expect(getCachedStatus('OLD', 60_000)).toBeNull();
        expect(getCachedStatus('DEV-1', 60_000)).toBeNull();
      });
    }
  });
});

// ── c. Different profiles → different directories, no cross-contamination ───

describe('cache scoping — profile isolation', () => {
  it('keeps inventory and status isolated when legacy profile hash prefixes collide', () => {
    const first = 'profile-55372';
    const second = 'profile-65052';
    withRequestContext({ profile: first }, () => {
      updateCacheFromDeviceList(sampleBody);
      setCachedStatus('DEV-1', { power: 'on' });
    });
    withRequestContext({ profile: second }, () => {
      expect(loadCache()).toBeNull();
      expect(getCachedStatus('DEV-1', 60_000)).toBeNull();
      updateCacheFromDeviceList({
        deviceList: [{ deviceId: 'DEV-2', deviceName: 'Plug', deviceType: 'Plug' }],
        infraredRemoteList: [],
      });
      setCachedStatus('DEV-2', { power: 'off' });
    });
    resetListCache();
    resetStatusCache();

    withRequestContext({ profile: first }, () => {
      expect(Object.keys(loadCache()!.devices)).toEqual(['DEV-1']);
      expect(getCachedStatus('DEV-1', 60_000)).toEqual({ power: 'on' });
      expect(getCachedStatus('DEV-2', 60_000)).toBeNull();
      clearCache();
      clearStatusCache();
    });
    withRequestContext({ profile: second }, () => {
      expect(Object.keys(loadCache()!.devices)).toEqual(['DEV-2']);
      expect(getCachedStatus('DEV-2', 60_000)).toEqual({ power: 'off' });
    });
  });
});

// ── d. Status cache parity ───────────────────────────────────────────────────

describe('cache scoping — status cache follows the same rule', () => {
  it('no profile → status.json at legacy ~/.switchbot/status.json', () => {
    setCachedStatus('DEV-1', { power: 'on' });

    const legacy = path.join(tmpDir, '.switchbot', 'status.json');
    expect(fs.existsSync(legacy)).toBe(true);

    const scopedDir = path.join(tmpDir, '.switchbot', 'cache');
    expect(fs.existsSync(scopedDir)).toBe(false);
  });
});

// ── e. In-memory cache does not leak across profile switches ─────────────────

describe('cache scoping — in-memory hot cache isolation across profiles', () => {
  it('in-memory cache does not leak across profile switches within a single process', () => {
    const alphaBody = {
      deviceList: [{ deviceId: 'ALPHA-1', deviceName: 'Alpha Bot', deviceType: 'Bot' }],
      infraredRemoteList: [],
    };
    const betaBody = {
      deviceList: [{ deviceId: 'BETA-1', deviceName: 'Beta Plug', deviceType: 'Plug' }],
      infraredRemoteList: [],
    };

    // Write alpha cache on disk and populate in-memory hot cache for alpha.
    withRequestContext({ profile: 'alpha' }, () => {
      updateCacheFromDeviceList(alphaBody);
    });

    // Verify alpha is in-memory.
    const alphaResult = withRequestContext({ profile: 'alpha' }, () => loadCache());
    expect(alphaResult?.devices['ALPHA-1']).toBeDefined();

    // Write beta's inventory directly to disk (bypassing the hot-cache write path),
    // simulating the scenario where beta's data was written in a prior process and
    // only the hot cache is "stale" (points to alpha).
    const betaDir = readCredentialScope('beta').cacheDir;
    fs.mkdirSync(betaDir, { recursive: true });
    const betaCache = {
      lastUpdated: new Date().toISOString(),
      devices: { 'BETA-1': { type: 'Plug', name: 'Beta Plug', category: 'physical' } },
    };
    fs.writeFileSync(path.join(betaDir, 'devices.json'), JSON.stringify(betaCache));

    // Read under profile "beta" WITHOUT calling resetListCache() first.
    // With the bug (single global _listCache), this would return alpha's data.
    // With the fix (Map keyed by profile), this must read from disk and return beta's data.
    const betaResult = withRequestContext({ profile: 'beta' }, () => loadCache());

    expect(betaResult?.devices['BETA-1']).toBeDefined();
    expect(betaResult?.devices['ALPHA-1']).toBeUndefined();
  });
});

// ── f. --config-path override takes precedence (profile is ignored) ──────────

describe('cache scoping — --config-path override', () => {
  it('uses config override dirname regardless of active profile', () => {
    const custom = path.join(tmpDir, 'alt', 'cfg.json');
    fs.mkdirSync(path.dirname(custom), { recursive: true });
    process.argv = ['node', 'switchbot', '--config', custom];
    resetListCache();
    resetStatusCache();

    withRequestContext({ profile: 'alpha' }, () => {
      updateCacheFromDeviceList(sampleBody);
    });

    // Must land in the override dir, not the scoped dir
    const overrideFile = path.join(tmpDir, 'alt', 'devices.json');
    expect(fs.existsSync(overrideFile)).toBe(true);

    // Neither legacy nor scoped paths should exist
    const legacy = path.join(tmpDir, '.switchbot', 'devices.json');
    const scoped = path.join(tmpDir, '.switchbot', 'cache', sha8('alpha'), 'devices.json');
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(scoped)).toBe(false);
  });
});
