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
