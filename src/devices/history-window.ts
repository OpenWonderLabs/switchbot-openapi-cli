import fs from 'node:fs';
import readline from 'node:readline';
import { jsonlFilesForDevice, parseDurationToMs, type HistoryRecord } from './history-query.js';

export interface EventWindowOptions {
  /** Inclusive lower bound (ms epoch). */
  sinceMs: number;
  /** Inclusive upper bound (ms epoch). */
  untilMs: number;
  /** Optional predicate to filter parsed records. Records that don't match are dropped. */
  eventFilter?: (record: HistoryRecord) => boolean;
  /** Cap the number of records returned (newest-first ordering preserved). */
  limit?: number;
}

/**
 * Query a device's history JSONL files for records in [sinceMs, untilMs].
 *
 * Walks rotation files newest-first so consumers that only care about the
 * most-recent N events don't have to read the full archive. Stops as soon
 * as a file's mtime is older than `sinceMs` (the file can't contain any
 * records that match) or `limit` records have been collected.
 *
 * Returned records are in file order within each file (oldest-first
 * inside a file, newer files first).
 */
export async function queryEventWindow(
  deviceId: string,
  opts: EventWindowOptions,
): Promise<HistoryRecord[]> {
  const { sinceMs, untilMs } = opts;
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) return [];
  if (sinceMs > untilMs) return [];
  const limit = Math.max(0, opts.limit ?? Number.POSITIVE_INFINITY);
  if (limit === 0) return [];

  // jsonlFilesForDevice returns oldest-first; walk newest-first so we can
  // bail early once we hit a file whose mtime predates the window.
  const files = jsonlFilesForDevice(deviceId).slice().reverse();
  const out: HistoryRecord[] = [];

  for (const file of files) {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    // The newest record in the file is no later than mtime; if the file
    // ends before our window starts, neither it nor any older file can
    // contribute.
    if (mtimeMs < sinceMs) break;

    const records = await readWindowFromFile(file, sinceMs, untilMs, opts.eventFilter);
    out.push(...records);
    if (out.length >= limit) {
      return out.slice(0, limit);
    }
  }

  return out;
}

async function readWindowFromFile(
  file: string,
  sinceMs: number,
  untilMs: number,
  eventFilter: ((record: HistoryRecord) => boolean) | undefined,
): Promise<HistoryRecord[]> {
  const stream = fs.createReadStream(file, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const out: HistoryRecord[] = [];
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
    if (tMs < sinceMs || tMs > untilMs) continue;
    if (eventFilter && !eventFilter(rec)) continue;
    out.push(rec);
  }
  return out;
}

export { parseDurationToMs };
