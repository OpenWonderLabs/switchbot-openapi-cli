import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getConfigPath } from '../utils/flags.js';

export interface CachedDevice {
  type: string;
  name: string;
  category: 'physical' | 'ir';
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
  }>;
  infraredRemoteList: Array<{
    deviceId: string;
    deviceName: string;
    remoteType: string;
  }>;
}

function cacheFilePath(): string {
  const override = getConfigPath();
  const dir = override
    ? path.dirname(path.resolve(override))
    : path.join(os.homedir(), '.switchbot');
  return path.join(dir, 'devices.json');
}

export function loadCache(): DeviceCache | null {
  const file = cacheFilePath();
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const cache = JSON.parse(raw) as DeviceCache;
    if (!cache || typeof cache.devices !== 'object' || cache.devices === null) {
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

export function getCachedDevice(deviceId: string): CachedDevice | null {
  const cache = loadCache();
  if (!cache) return null;
  return cache.devices[deviceId] ?? null;
}

export function updateCacheFromDeviceList(body: DeviceListBodyShape): void {
  const devices: Record<string, CachedDevice> = {};

  for (const d of body.deviceList) {
    if (!d.deviceId || !d.deviceType) continue;
    devices[d.deviceId] = {
      type: d.deviceType,
      name: d.deviceName,
      category: 'physical',
    };
  }
  for (const d of body.infraredRemoteList) {
    if (!d.deviceId) continue;
    devices[d.deviceId] = {
      type: d.remoteType,
      name: d.deviceName,
      category: 'ir',
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
  } catch {
    // Cache write failures must not break the command that triggered them.
  }
}

export function clearCache(): void {
  const file = cacheFilePath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
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
    : path.join(os.homedir(), '.switchbot');
  return path.join(dir, 'status.json');
}

export function loadStatusCache(): StatusCache {
  const file = statusCacheFilePath();
  if (!fs.existsSync(file)) return { entries: {} };
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as StatusCache;
    if (!parsed || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return { entries: {} };
    }
    return parsed;
  } catch {
    return { entries: {} };
  }
}

function saveStatusCache(cache: StatusCache): void {
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

export function setCachedStatus(
  deviceId: string,
  body: Record<string, unknown>,
  now = new Date()
): void {
  const cache = loadStatusCache();
  cache.entries[deviceId] = {
    fetchedAt: now.toISOString(),
    body,
  };
  saveStatusCache(cache);
}

export function clearStatusCache(): void {
  const file = statusCacheFilePath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
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
