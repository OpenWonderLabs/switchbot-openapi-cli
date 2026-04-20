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
const JSONL_ROTATE_BYTES = 50 * 1024 * 1024; // 50 MB
const JSONL_KEEP_ROTATIONS = 3;               // .1 .2 .3

function historyDir(): string {
  return path.join(os.homedir(), '.switchbot', 'device-history');
}

export class DeviceHistoryStore {
  // In-memory size counter so we don't stat() on every append.
  private jsonlSizes: Map<string, number> = new Map();

  /** Reset the in-memory size counter. Tests use this between runs. */
  resetSizes(): void {
    this.jsonlSizes.clear();
  }

  private get dir(): string {
    return historyDir();
  }

  record(deviceId: string, topic: string, deviceType: string, payload: unknown, t?: string): void {
    const entry: HistoryEntry = { t: t ?? new Date().toISOString(), topic, deviceType, payload };
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });

      // 1. Ring-buffer JSON (back-compat with existing consumers).
      const file = path.join(this.dir, `${deviceId}.json`);
      const existing: DeviceHistory = fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, 'utf-8')) as DeviceHistory)
        : { latest: null, history: [] };
      existing.latest = entry;
      existing.history = [entry, ...existing.history].slice(0, MAX_HISTORY);
      fs.writeFileSync(file, JSON.stringify(existing, null, 2), { mode: 0o600 });

      // 2. Append-only JSONL for range queries.
      this.appendJsonl(deviceId, entry);
    } catch {
      // best-effort — history loss is non-fatal
    }
  }

  private appendJsonl(deviceId: string, entry: HistoryEntry): void {
    try {
      const jsonlPath = path.join(this.dir, `${deviceId}.jsonl`);
      const line = JSON.stringify(entry) + '\n';
      const lineBytes = Buffer.byteLength(line, 'utf-8');

      // Seed size counter from disk on first touch (avoids drift across restarts).
      let size = this.jsonlSizes.get(deviceId);
      if (size === undefined) {
        try {
          size = fs.existsSync(jsonlPath) ? fs.statSync(jsonlPath).size : 0;
        } catch {
          size = 0;
        }
      }

      if (size + lineBytes > JSONL_ROTATE_BYTES) {
        this.rotateJsonl(deviceId);
        size = 0;
      }

      fs.appendFileSync(jsonlPath, line, { mode: 0o600 });
      this.jsonlSizes.set(deviceId, size + lineBytes);
    } catch {
      // best-effort
    }
  }

  private rotateJsonl(deviceId: string): void {
    const base = path.join(this.dir, `${deviceId}.jsonl`);
    // .jsonl.3 is dropped; .2 → .3, .1 → .2, current → .1
    try {
      const oldest = `${base}.${JSONL_KEEP_ROTATIONS}`;
      if (fs.existsSync(oldest)) fs.rmSync(oldest);
    } catch { /* swallow */ }
    for (let i = JSONL_KEEP_ROTATIONS - 1; i >= 1; i--) {
      const from = `${base}.${i}`;
      const to = `${base}.${i + 1}`;
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch { /* swallow */ }
    }
    try {
      if (fs.existsSync(base)) fs.renameSync(base, `${base}.1`);
    } catch { /* swallow */ }
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
      const seen = new Set<string>();
      for (const f of fs.readdirSync(this.dir)) {
        if (f.endsWith('.json')) seen.add(f.slice(0, -5));
        else if (f.endsWith('.jsonl')) seen.add(f.slice(0, -6));
      }
      return Array.from(seen);
    } catch {
      return [];
    }
  }

  getHistoryDir(): string {
    return this.dir;
  }
}

export const deviceHistoryStore = new DeviceHistoryStore();
