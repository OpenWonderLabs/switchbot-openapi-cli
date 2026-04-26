import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { getConfigPath } from '../utils/flags.js';
import { getActiveProfile } from '../lib/request-context.js';

/**
 * Returns the directory where cache files should be stored.
 *
 * - If a profile is active, scopes into a per-profile sub-directory so that
 *   rotating credentials or switching profiles never serves stale inventory
 *   from a prior session (Bug #37).
 * - If no profile is active (unnamed / default), returns `baseDir` unchanged
 *   so the existing legacy path (~/.switchbot/devices.json) is preserved.
 *
 * Only called when `getConfigPath()` returns undefined — the --config-path
 * override takes full precedence and bypasses this helper entirely.
 */
function scopedCacheDir(baseDir: string): string {
  const profile = getActiveProfile();
  if (profile === undefined) return baseDir;
  const hash = createHash('sha256').update(profile).digest('hex').slice(0, 8);
  const dir = path.join(baseDir, 'cache', hash);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** GC cutoff for status entries: evict anything older than this. */
const DEFAULT_STATUS_GC_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

export interface CachedDevice {
  type: string;
  name: string;
  category: 'physical' | 'ir';
  hubDeviceId?: string;
  enableCloudService?: boolean;
  roomID?: string;
  roomName?: string | null;
  familyName?: string;
  controlType?: string;
}

export interface DeviceCache {
  lastUpdated: string;
  devices: Record<string, CachedDevice>;
}

export interface DeviceListBodyShape {
  deviceList: Array<{
    deviceId: string;
    deviceName: string;
    deviceType?: string;
    hubDeviceId?: string;
    enableCloudService?: boolean;
    roomID?: string;
    roomName?: string | null;
    familyName?: string;
    controlType?: string;
  }>;
  infraredRemoteList: Array<{
    deviceId: string;
    deviceName: string;
    remoteType: string;
    hubDeviceId?: string;
    controlType?: string;
  }>;
}

function cacheFilePath(): string {
  const override = getConfigPath();
  const dir = override
    ? path.dirname(path.resolve(override))
    : scopedCacheDir(path.join(os.homedir(), '.switchbot'));
  return path.join(dir, 'devices.json');
}

// In-memory hot-cache keyed by active profile (or '__default__' for no profile).
// Using Maps instead of module-level singletons ensures that mcp serve, which
// rotates profiles per request via withRequestContext, never leaks inventory
// across profiles within the same process (Bug #37).
const _listCacheByProfile = new Map<string, DeviceCache | null>();
const _statusCacheByProfile = new Map<string, StatusCache>();

function cacheKey(): string {
  return getActiveProfile() ?? '__default__';
}

/** Force the next loadCache() call to re-read from disk. Used in tests. */
export function resetListCache(): void {
  _listCacheByProfile.clear();
}

/** Force the next loadStatusCache() call to re-read from disk. Used in tests. */
export function resetStatusCache(): void {
  _statusCacheByProfile.clear();
}

export function loadCache(): DeviceCache | null {
  const key = cacheKey();
  if (_listCacheByProfile.has(key)) return _listCacheByProfile.get(key)!;
  const file = cacheFilePath();
  if (!fs.existsSync(file)) {
    _listCacheByProfile.set(key, null);
    return null;
  }
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const cache = JSON.parse(raw) as DeviceCache;
    if (!cache || typeof cache.devices !== 'object' || cache.devices === null) {
      _listCacheByProfile.set(key, null);
      return null;
    }
    _listCacheByProfile.set(key, cache);
    return cache;
  } catch {
    _listCacheByProfile.set(key, null);
    return null;
  }
}

export function getCachedDevice(deviceId: string): CachedDevice | null {
  const cache = loadCache();
  if (!cache) return null;
  return cache.devices[deviceId] ?? null;
}

/** Build a deviceId -> type map from the metadata cache. */
export function getCachedTypeMap(deviceIds?: Iterable<string>): Map<string, string> {
  const cache = loadCache();
  const out = new Map<string, string>();
  if (!cache) return out;

  if (deviceIds) {
    for (const id of deviceIds) {
      const entry = cache.devices[id];
      if (entry?.type) out.set(id, entry.type);
    }
    return out;
  }

  for (const [deviceId, entry] of Object.entries(cache.devices)) {
    if (entry.type) out.set(deviceId, entry.type);
  }
  return out;
}

export function updateCacheFromDeviceList(body: DeviceListBodyShape): void {
  const devices: Record<string, CachedDevice> = {};

  for (const d of body.deviceList) {
    if (!d.deviceId) continue;
    devices[d.deviceId] = {
      // Some real devices omit deviceType entirely (for example AI accessories).
      // Keep them in cache with an empty type string rather than dropping the row.
      type: d.deviceType ?? '',
      name: d.deviceName,
      category: 'physical',
      hubDeviceId: d.hubDeviceId,
      enableCloudService: d.enableCloudService,
      roomID: d.roomID,
      roomName: d.roomName,
      familyName: d.familyName,
      controlType: d.controlType,
    };
  }
  for (const d of body.infraredRemoteList) {
    if (!d.deviceId) continue;
    devices[d.deviceId] = {
      type: d.remoteType,
      name: d.deviceName,
      category: 'ir',
      hubDeviceId: d.hubDeviceId,
      controlType: d.controlType,
    };
  }

  const cache: DeviceCache = {
    lastUpdated: new Date().toISOString(),
    devices,
  };

  try {
    const file = cacheFilePath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 });
    _listCacheByProfile.set(cacheKey(), cache);
  } catch {
    // Cache write failures must not break the command that triggered them.
  }
}

export function clearCache(): void {
  const file = cacheFilePath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
  _listCacheByProfile.set(cacheKey(), null);
}

// ---- Device list freshness -------------------------------------------------

/** Age of the on-disk list cache in ms, or null if there is no cache. */
export function listCacheAgeMs(now = Date.now()): number | null {
  const cache = loadCache();
  if (!cache) return null;
  const ts = Date.parse(cache.lastUpdated);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, now - ts);
}

/** True when the on-disk list cache is present and younger than `ttlMs`. */
export function isListCacheFresh(ttlMs: number, now = Date.now()): boolean {
  if (!ttlMs || ttlMs <= 0) return false;
  const age = listCacheAgeMs(now);
  return age !== null && age < ttlMs;
}

// ---- Status cache ---------------------------------------------------------
//
// Separate file from the device metadata cache because:
//   - status is frequently invalidated, metadata is stable
//   - clear commands should be able to scope to one or the other
//   - the file can be deleted freely without losing the command-validation
//     hints that the metadata cache provides
//
// Layout: { entries: { <deviceId>: { fetchedAt: ISO, body: <raw API body> } } }

export interface CachedStatus {
  fetchedAt: string;
  body: Record<string, unknown>;
}

export interface StatusCache {
  entries: Record<string, CachedStatus>;
}

function statusCacheFilePath(): string {
  const override = getConfigPath();
  const dir = override
    ? path.dirname(path.resolve(override))
    : scopedCacheDir(path.join(os.homedir(), '.switchbot'));
  return path.join(dir, 'status.json');
}

export function loadStatusCache(): StatusCache {
  const key = cacheKey();
  if (_statusCacheByProfile.has(key)) return _statusCacheByProfile.get(key)!;
  const file = statusCacheFilePath();
  if (!fs.existsSync(file)) {
    const empty = { entries: {} };
    _statusCacheByProfile.set(key, empty);
    return empty;
  }
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as StatusCache;
    if (!parsed || typeof parsed.entries !== 'object' || parsed.entries === null) {
      const empty = { entries: {} };
      _statusCacheByProfile.set(key, empty);
      return empty;
    }
    _statusCacheByProfile.set(key, parsed);
    return parsed;
  } catch {
    const empty = { entries: {} };
    _statusCacheByProfile.set(key, empty);
    return empty;
  }
}

function saveStatusCache(cache: StatusCache): void {
  _statusCacheByProfile.set(cacheKey(), cache);
  try {
    const file = statusCacheFilePath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

/** Read a status entry; returns null when missing or older than `ttlMs`. */
export function getCachedStatus(
  deviceId: string,
  ttlMs: number,
  now = Date.now()
): Record<string, unknown> | null {
  if (!ttlMs || ttlMs <= 0) return null;
  const cache = loadStatusCache();
  const entry = cache.entries[deviceId];
  if (!entry) return null;
  const ts = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(ts)) return null;
  if (now - ts >= ttlMs) return null;
  return entry.body;
}

/** Evict status entries older than max(ttlMs × 10, 24 h) to bound file growth. */
function evictExpiredStatusEntries(cache: StatusCache, ttlMs: number, now = Date.now()): void {
  const cutoff = now - Math.max(ttlMs * 10, 24 * 60 * 60 * 1000);
  for (const id of Object.keys(cache.entries)) {
    const entry = cache.entries[id];
    const ts = Date.parse(entry.fetchedAt);
    if (!Number.isFinite(ts) || ts < cutoff) delete cache.entries[id];
  }
}

export function setCachedStatus(
  deviceId: string,
  body: Record<string, unknown>,
  now = new Date(),
  ttlMsForGc = DEFAULT_STATUS_GC_TTL_MS
): void {
  const cache = loadStatusCache();
  cache.entries[deviceId] = {
    fetchedAt: now.toISOString(),
    body,
  };
  evictExpiredStatusEntries(cache, ttlMsForGc, now.getTime());
  saveStatusCache(cache);
}

export function clearStatusCache(): void {
  const file = statusCacheFilePath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
  _statusCacheByProfile.set(cacheKey(), { entries: {} });
}

/** Summary for `switchbot cache show`. */
export interface CacheSummary {
  list: {
    path: string;
    exists: boolean;
    lastUpdated?: string;
    ageMs?: number;
    deviceCount?: number;
  };
  status: {
    path: string;
    exists: boolean;
    entryCount: number;
    oldestFetchedAt?: string;
    newestFetchedAt?: string;
  };
}

export function describeCache(now = Date.now()): CacheSummary {
  const listFile = cacheFilePath();
  const listCache = loadCache();
  const listExists = fs.existsSync(listFile);
  const list: CacheSummary['list'] = {
    path: listFile,
    exists: listExists,
  };
  if (listCache) {
    list.lastUpdated = listCache.lastUpdated;
    const ts = Date.parse(listCache.lastUpdated);
    if (Number.isFinite(ts)) list.ageMs = Math.max(0, now - ts);
    list.deviceCount = Object.keys(listCache.devices).length;
  }

  const statusFile = statusCacheFilePath();
  const statusExists = fs.existsSync(statusFile);
  const statusCache = loadStatusCache();
  const entries = Object.values(statusCache.entries);
  const status: CacheSummary['status'] = {
    path: statusFile,
    exists: statusExists,
    entryCount: entries.length,
  };
  if (entries.length > 0) {
    const sorted = entries
      .map((e) => e.fetchedAt)
      .filter((s): s is string => typeof s === 'string')
      .sort();
    status.oldestFetchedAt = sorted[0];
    status.newestFetchedAt = sorted[sorted.length - 1];
  }

  return { list, status };
}
