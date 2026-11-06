import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertCredentialScope, readCredentialScope, type CredentialScope } from '../credentials/scope.js';

/** GC cutoff for status entries: evict anything older than this. */
const DEFAULT_STATUS_GC_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

export interface CachedDevice {
  type: string;
  typeSource?: 'deviceType' | 'controlType' | 'remoteType';
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

function cacheFilePath(scope = readCredentialScope()): string {
  return path.join(scope.cacheDir, 'devices.json');
}

interface CacheSnapshot<T> {
  revision: string;
  value: T;
}

/** Commit the data and its credential revision as one indivisible document. */
function writeCacheFile(file: string, cache: DeviceCache | StatusCache, scope: CredentialScope): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...cache, _credentialRevision: scope.revision }, null, 2), {
      mode: 0o600, flag: 'wx',
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// Storage scope includes --config precedence; revisions invalidate warm readers
// when credentials are changed by a different process.
const _listCacheByScope = new Map<string, CacheSnapshot<DeviceCache | null>>();
const _statusCacheByScope = new Map<string, CacheSnapshot<StatusCache>>();

/** Force the next loadCache() call to re-read from disk. Used in tests. */
export function resetListCache(): void {
  _listCacheByScope.clear();
}

/** Force the next loadStatusCache() call to re-read from disk. Used in tests. */
export function resetStatusCache(): void {
  _statusCacheByScope.clear();
}

export function loadCache(): DeviceCache | null {
  const scope = readCredentialScope();
  const snapshot = _listCacheByScope.get(scope.key);
  if (snapshot?.revision === scope.revision) return snapshot.value;
  let value: DeviceCache | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFilePath(scope), 'utf8')) as DeviceCache & { _credentialRevision?: string };
    if (parsed && typeof parsed.devices === 'object' && parsed.devices !== null &&
        (parsed._credentialRevision ?? '') === scope.revision) {
      value = { lastUpdated: parsed.lastUpdated, devices: parsed.devices };
    }
  } catch {
    // Missing, unreadable or malformed cache data is a cache miss.
  }
  _listCacheByScope.set(scope.key, { revision: scope.revision, value });
  return value;
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

export function updateCacheFromDeviceList(body: DeviceListBodyShape, scope = readCredentialScope()): void {
  assertCredentialScope(scope);
  const devices: Record<string, CachedDevice> = {};

  for (const d of body.deviceList) {
    if (!d.deviceId) continue;
    devices[d.deviceId] = {
      type: d.deviceType || d.controlType || 'Unknown Device',
      typeSource: d.deviceType ? 'deviceType' : d.controlType ? 'controlType' : 'deviceType',
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
    const hub = d.hubDeviceId ? devices[d.hubDeviceId] : undefined;
    devices[d.deviceId] = {
      type: d.remoteType,
      typeSource: 'remoteType',
      name: d.deviceName,
      category: 'ir',
      hubDeviceId: d.hubDeviceId,
      controlType: d.controlType,
      familyName: hub?.familyName,
      roomID: hub?.roomID,
      roomName: hub?.roomName,
    };
  }

  const cache: DeviceCache = {
    lastUpdated: new Date().toISOString(),
    devices,
  };

  try {
    writeCacheFile(cacheFilePath(scope), cache, scope);
    _listCacheByScope.set(scope.key, { revision: scope.revision, value: cache });
  } catch {
    // Cache write failures must not break the command that triggered them.
  }
  assertCredentialScope(scope);
}

export function clearCache(scope = readCredentialScope()): void {
  _listCacheByScope.set(scope.key, { revision: scope.revision, value: null });
  const file = cacheFilePath(scope);
  if (fs.existsSync(file)) {
    try { fs.unlinkSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EBUSY') throw e; }
  }
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

function statusCacheFilePath(scope = readCredentialScope()): string {
  return path.join(scope.cacheDir, 'status.json');
}

export function loadStatusCache(): StatusCache {
  const scope = readCredentialScope();
  const snapshot = _statusCacheByScope.get(scope.key);
  if (snapshot?.revision === scope.revision) return snapshot.value;
  let value: StatusCache = { entries: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(statusCacheFilePath(scope), 'utf8')) as StatusCache & { _credentialRevision?: string };
    if (parsed && typeof parsed.entries === 'object' && parsed.entries !== null &&
        (parsed._credentialRevision ?? '') === scope.revision) {
      value = { entries: parsed.entries };
    }
  } catch {
    // Missing, unreadable or malformed cache data is a cache miss.
  }
  _statusCacheByScope.set(scope.key, { revision: scope.revision, value });
  return value;
}

function saveStatusCache(cache: StatusCache, scope: CredentialScope): void {
  _statusCacheByScope.set(scope.key, { revision: scope.revision, value: cache });
  try {
    writeCacheFile(statusCacheFilePath(scope), cache, scope);
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

/** Read a status entry with its stored fetchedAt timestamp; null when missing or expired. */
export function getCachedStatusEntry(
  deviceId: string,
  ttlMs: number,
  now = Date.now()
): { body: Record<string, unknown>; fetchedAt: string } | null {
  if (!ttlMs || ttlMs <= 0) return null;
  const cache = loadStatusCache();
  const entry = cache.entries[deviceId];
  if (!entry) return null;
  const ts = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(ts)) return null;
  if (now - ts >= ttlMs) return null;
  return { body: entry.body, fetchedAt: entry.fetchedAt };
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
  ttlMsForGc = DEFAULT_STATUS_GC_TTL_MS,
  scope = readCredentialScope(),
): void {
  assertCredentialScope(scope);
  const cache = loadStatusCache();
  cache.entries[deviceId] = {
    fetchedAt: now.toISOString(),
    body,
  };
  evictExpiredStatusEntries(cache, ttlMsForGc, now.getTime());
  saveStatusCache(cache, scope);
  assertCredentialScope(scope);
}

export function clearStatusCache(scope = readCredentialScope()): void {
  _statusCacheByScope.set(scope.key, { revision: scope.revision, value: { entries: {} } });
  const file = statusCacheFilePath(scope);
  if (fs.existsSync(file)) {
    try { fs.unlinkSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EBUSY') throw e; }
  }
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
