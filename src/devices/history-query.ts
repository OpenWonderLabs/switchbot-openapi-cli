import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

export interface HistoryRecord {
  t: string;
  topic: string;
  deviceType?: string;
  payload: unknown;
}

export interface QueryOptions {
  since?: string;
  from?: string;
  to?: string;
  fields?: string[];
  limit?: number;
}

export interface HistoryStats {
  deviceId: string;
  fileCount: number;
  totalBytes: number;
  recordCount: number;
  oldest?: string;
  newest?: string;
  jsonlFiles: string[];
  historyDir: string;
}

const DEFAULT_LIMIT = 1000;

function historyDir(): string {
  return path.join(os.homedir(), '.switchbot', 'device-history');
}

/**
 * Parse a duration shortcut like "7d", "12h", "30m", "45s" into milliseconds.
 * Returns null on malformed input (caller throws UsageError).
 */
export function parseDurationToMs(spec: string): number | null {
  const m = spec.trim().match(/^(\d+)(ms|s|m|h|d)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * factor;
}

/** Parse ISO-8601 (with Z or offset) or Date-parseable string → ms, else null. */
export function parseInstantToMs(spec: string): number | null {
  const ms = Date.parse(spec);
  return Number.isFinite(ms) ? ms : null;
}

export function resolveRange(opts: QueryOptions): { fromMs: number; toMs: number } {
  let fromMs = Number.NEGATIVE_INFINITY;
  let toMs = Number.POSITIVE_INFINITY;

  if (opts.since && (opts.from || opts.to)) {
    throw new Error('--since is mutually exclusive with --from/--to.');
  }

  if (opts.since) {
    const durMs = parseDurationToMs(opts.since);
    if (durMs === null) {
      throw new Error(`Invalid --since value "${opts.since}". Expected e.g. "30s", "15m", "1h", "7d".`);
    }
    fromMs = Date.now() - durMs;
  } else {
    if (opts.from) {
      const parsed = parseInstantToMs(opts.from);
      if (parsed === null) throw new Error(`Invalid --from value "${opts.from}". Expected ISO-8601 timestamp.`);
      fromMs = parsed;
    }
    if (opts.to) {
      const parsed = parseInstantToMs(opts.to);
      if (parsed === null) throw new Error(`Invalid --to value "${opts.to}". Expected ISO-8601 timestamp.`);
      toMs = parsed;
    }
    if (fromMs > toMs) throw new Error('--from must be <= --to.');
  }

  return { fromMs, toMs };
}

/** Return jsonl candidate files for a device, oldest-first. */
export function jsonlFilesForDevice(deviceId: string, baseDir = historyDir()): string[] {
  const out: string[] = [];
  if (!fs.existsSync(baseDir)) return out;
  // Oldest-first so range walks can bail early once a line overshoots `toMs`.
  for (let i = 3; i >= 1; i--) {
    const p = path.join(baseDir, `${deviceId}.jsonl.${i}`);
    if (fs.existsSync(p)) out.push(p);
  }
  const current = path.join(baseDir, `${deviceId}.jsonl`);
  if (fs.existsSync(current)) out.push(current);
  return out;
}

function projectFields(record: HistoryRecord, fields: string[]): HistoryRecord {
  if (fields.length === 0) return record;
  const projected: Record<string, unknown> = {};
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  for (const f of fields) {
    if (f in payload) projected[f] = payload[f];
  }
  return { t: record.t, topic: record.topic, deviceType: record.deviceType, payload: projected };
}

/**
 * Stream-read the JSONL rotation files for `deviceId` and return records
 * within [fromMs, toMs]. Parse failures are silently dropped (best-effort).
 *
 * Files whose mtime < fromMs are skipped whole (coarse but sound: the newest
 * record in the file is <= mtime, so nothing in it can match).
 */
export async function queryDeviceHistory(
  deviceId: string,
  opts: QueryOptions = {},
): Promise<HistoryRecord[]> {
  const { fromMs, toMs } = resolveRange(opts);
  const limit = Math.max(0, opts.limit ?? DEFAULT_LIMIT);
  const fields = opts.fields ?? [];
  const files = jsonlFilesForDevice(deviceId);
  const out: HistoryRecord[] = [];

  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs < fromMs) continue;
    } catch {
      continue;
    }

    const stream = fs.createReadStream(file, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let rec: HistoryRecord;
      try {
        rec = JSON.parse(line) as HistoryRecord;
      } catch {
        continue;
      }
      const tMs = Date.parse(rec.t);
      if (!Number.isFinite(tMs)) continue;
      if (tMs < fromMs || tMs > toMs) continue;
      out.push(projectFields(rec, fields));
      if (out.length >= limit) {
        rl.close();
        stream.destroy();
        return out;
      }
    }
  }
  return out;
}

export function queryDeviceHistoryStats(deviceId: string): HistoryStats {
  const dir = historyDir();
  const files = jsonlFilesForDevice(deviceId);
  let totalBytes = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  let count = 0;

  for (const file of files) {
    try {
      totalBytes += fs.statSync(file).size;
    } catch { /* */ }
  }

  // Walk the oldest file's head + current file's tail for oldest/newest + count.
  // Counting is O(records) here, acceptable for "stats" which isn't a hot path.
  for (const file of files) {
    try {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line) continue;
        count += 1;
        try {
          const rec = JSON.parse(line) as HistoryRecord;
          const tMs = Date.parse(rec.t);
          if (Number.isFinite(tMs)) {
            if (oldest === null || tMs < oldest) oldest = tMs;
            if (newest === null || tMs > newest) newest = tMs;
          }
        } catch { /* */ }
      }
    } catch { /* */ }
  }

  return {
    deviceId,
    fileCount: files.length,
    totalBytes,
    recordCount: count,
    oldest: oldest !== null ? new Date(oldest).toISOString() : undefined,
    newest: newest !== null ? new Date(newest).toISOString() : undefined,
    jsonlFiles: files.map((f) => path.basename(f)),
    historyDir: dir,
  };
}
