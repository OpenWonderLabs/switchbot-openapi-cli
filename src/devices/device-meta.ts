import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getConfigPath } from '../utils/flags.js';

export interface DeviceMeta {
  alias?: string;
  hidden?: boolean;
  notes?: string;
}

export interface DeviceMetaFile {
  version: '1';
  devices: Record<string, DeviceMeta>;
}

function metaFilePath(): string {
  const override = getConfigPath();
  const dir = override
    ? path.dirname(path.resolve(override))
    : path.join(os.homedir(), '.switchbot');
  return path.join(dir, 'device-meta.json');
}

export function getMetaFilePath(): string {
  return metaFilePath();
}

export function loadDeviceMeta(): DeviceMetaFile {
  const file = metaFilePath();
  if (!fs.existsSync(file)) return { version: '1', devices: {} };
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as DeviceMetaFile;
    if (!parsed || typeof parsed.devices !== 'object' || parsed.devices === null) {
      return { version: '1', devices: {} };
    }
    return parsed;
  } catch {
    return { version: '1', devices: {} };
  }
}

export function saveDeviceMeta(meta: DeviceMetaFile): void {
  const file = metaFilePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(meta, null, 2), { mode: 0o600 });
}

export function getDeviceMeta(deviceId: string): DeviceMeta | null {
  const meta = loadDeviceMeta();
  return meta.devices[deviceId] ?? null;
}

export function setDeviceMeta(deviceId: string, patch: Partial<DeviceMeta>): void {
  const meta = loadDeviceMeta();
  meta.devices[deviceId] = { ...meta.devices[deviceId], ...patch };
  saveDeviceMeta(meta);
}

export function clearDeviceMeta(deviceId: string): void {
  const meta = loadDeviceMeta();
  delete meta.devices[deviceId];
  saveDeviceMeta(meta);
}
