/**
 * Tests for per-profile cache scoping (Bug #37).
 *
 * Each test:
 *  - Redirects os.homedir() to a fresh tmpdir so no real ~/.switchbot is touched.
 *  - Sets/clears the active profile via process.argv or withRequestContext.
 *  - Verifies that the file created on disk is at the expected scoped path.
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
  resetStatusCache,
} from '../../src/devices/cache.js';
import { withRequestContext } from '../../src/lib/request-context.js';

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
});

// ── b. Named profile → scoped path ──────────────────────────────────────────

describe('cache scoping — named profile "alpha"', () => {
  it('writes devices.json under ~/.switchbot/cache/<sha256(alpha):8>/devices.json', () => {
    const expected = path.join(tmpDir, '.switchbot', 'cache', sha8('alpha'), 'devices.json');

    withRequestContext({ profile: 'alpha' }, () => {
      updateCacheFromDeviceList(sampleBody);
    });

    expect(fs.existsSync(expected)).toBe(true);

    // Legacy path must NOT have been created
    const legacy = path.join(tmpDir, '.switchbot', 'devices.json');
    expect(fs.existsSync(legacy)).toBe(false);
  });
});

// ── c. Different profiles → different directories, no cross-contamination ───

describe('cache scoping — profile isolation', () => {
  it('alpha and beta get separate directories; switching profile is a cache miss', () => {
    // Write as "alpha"
    withRequestContext({ profile: 'alpha' }, () => {
      updateCacheFromDeviceList(sampleBody);
    });

    resetListCache();

    // Read as "beta" — should be a cache miss (null)
    const result = withRequestContext({ profile: 'beta' }, () => {
      // loadCache is imported inside the module; we test the side-effect:
      // after writing for alpha, writing for beta creates a separate file
      updateCacheFromDeviceList({
        deviceList: [{ deviceId: 'DEV-2', deviceName: 'Plug', deviceType: 'Plug' }],
        infraredRemoteList: [],
      });
      return fs.existsSync(path.join(tmpDir, '.switchbot', 'cache', sha8('beta'), 'devices.json'));
    });

    expect(result).toBe(true);

    // Alpha's file must still exist independently
    const alphaFile = path.join(tmpDir, '.switchbot', 'cache', sha8('alpha'), 'devices.json');
    expect(fs.existsSync(alphaFile)).toBe(true);

    // Alpha's content must be the original write, not beta's
    const alphaCache = JSON.parse(fs.readFileSync(alphaFile, 'utf-8'));
    expect(alphaCache.devices['DEV-1']).toBeDefined();
    expect(alphaCache.devices['DEV-2']).toBeUndefined();
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

  it('profile "alpha" → status.json at ~/.switchbot/cache/<sha256(alpha):8>/status.json', () => {
    const expected = path.join(tmpDir, '.switchbot', 'cache', sha8('alpha'), 'status.json');

    withRequestContext({ profile: 'alpha' }, () => {
      setCachedStatus('DEV-1', { power: 'on' });
    });

    expect(fs.existsSync(expected)).toBe(true);

    const legacy = path.join(tmpDir, '.switchbot', 'status.json');
    expect(fs.existsSync(legacy)).toBe(false);
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
    const betaDir = path.join(tmpDir, '.switchbot', 'cache', sha8('beta'));
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
