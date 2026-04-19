import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface HistoryEntry {
  t: string;
  topic: string;
  deviceType: string;
  payload: unknown;
}

export interface DeviceHistory {
  latest: HistoryEntry | null;
  history: HistoryEntry[];
}

const MAX_HISTORY = 100;

function historyDir(): string {
  return path.join(os.homedir(), '.switchbot', 'device-history');
}

export class DeviceHistoryStore {
  private dir: string;

  constructor() {
    this.dir = historyDir();
  }

  record(deviceId: string, topic: string, deviceType: string, payload: unknown, t?: string): void {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `${deviceId}.json`);
      const existing: DeviceHistory = fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, 'utf-8')) as DeviceHistory)
        : { latest: null, history: [] };
      const entry: HistoryEntry = { t: t ?? new Date().toISOString(), topic, deviceType, payload };
      existing.latest = entry;
      existing.history = [entry, ...existing.history].slice(0, MAX_HISTORY);
      fs.writeFileSync(file, JSON.stringify(existing, null, 2), { mode: 0o600 });
    } catch {
      // best-effort — history loss is non-fatal
    }
  }

  getLatest(deviceId: string): HistoryEntry | null {
    try {
      const file = path.join(this.dir, `${deviceId}.json`);
      if (!fs.existsSync(file)) return null;
      return (JSON.parse(fs.readFileSync(file, 'utf-8')) as DeviceHistory).latest;
    } catch {
      return null;
    }
  }

  getHistory(deviceId: string, limit = 20): HistoryEntry[] {
    try {
      const file = path.join(this.dir, `${deviceId}.json`);
      if (!fs.existsSync(file)) return [];
      const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as DeviceHistory;
      return data.history.slice(0, Math.min(limit, MAX_HISTORY));
    } catch {
      return [];
    }
  }

  listDevices(): string[] {
    try {
      if (!fs.existsSync(this.dir)) return [];
      return fs.readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }
}

export const deviceHistoryStore = new DeviceHistoryStore();
