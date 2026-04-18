/**
 * Local quota counter. Tracks the SwitchBot 10k/day request budget so the
 * CLI (and any AI agent) can check "how many calls have I already burned?"
 * without pinging the API.
 *
 * Shape (`~/.switchbot/quota.json`):
 *   {
 *     "days": {
 *       "2026-04-18": {
 *         "total": 42,
 *         "endpoints": {
 *           "GET /v1.1/devices": 3,
 *           "GET /v1.1/devices/:id/status": 27,
 *           "POST /v1.1/devices/:id/commands": 12
 *         }
 *       }
 *     }
 *   }
 *
 * We keep the last 7 days to bound the file size and give a short-term
 * trend. Writes are fire-and-forget — a failed write never breaks the
 * actual API call.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DAILY_QUOTA = 10_000;

export interface DayBucket {
  total: number;
  endpoints: Record<string, number>;
}

export interface QuotaFile {
  days: Record<string, DayBucket>;
}

const MAX_RETAINED_DAYS = 7;

function quotaFilePath(): string {
  return path.join(os.homedir(), '.switchbot', 'quota.json');
}

function today(now: Date = new Date()): string {
  // Local date, not UTC — SwitchBot's quota window is loose but users
  // reason about "today" in their own timezone.
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function emptyFile(): QuotaFile {
  return { days: {} };
}

export function loadQuota(): QuotaFile {
  const file = quotaFilePath();
  if (!fs.existsSync(file)) return emptyFile();
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as QuotaFile;
    if (!parsed || typeof parsed !== 'object' || !parsed.days) return emptyFile();
    return parsed;
  } catch {
    return emptyFile();
  }
}

function saveQuota(data: QuotaFile): void {
  const file = quotaFilePath();
  const dir = path.dirname(file);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {
    // swallow: counting is best-effort, must not break a real API call
  }
}

function prune(data: QuotaFile): QuotaFile {
  const keys = Object.keys(data.days).sort();
  if (keys.length <= MAX_RETAINED_DAYS) return data;
  const keep = keys.slice(keys.length - MAX_RETAINED_DAYS);
  const next: QuotaFile = { days: {} };
  for (const k of keep) next.days[k] = data.days[k];
  return next;
}

/**
 * Normalise a full URL into a SwitchBot-style endpoint pattern. The segment
 * immediately after `devices` or `scenes` is collapsed to `:id` so we can
 * bucket by endpoint shape rather than by specific deviceId/sceneId.
 */
export function normaliseEndpoint(method: string, url: string): string {
  const m = (method || 'GET').toUpperCase();
  let pathOnly = url;
  try {
    const parsed = new URL(url);
    pathOnly = parsed.pathname;
  } catch {
    const q = url.indexOf('?');
    if (q !== -1) pathOnly = url.slice(0, q);
  }
  const segments = pathOnly.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === 'devices' || segments[i] === 'scenes') {
      // Only collapse when the next segment looks like an id (not another
      // API verb); the SwitchBot API uses lower-case keywords elsewhere,
      // but guard against future collisions.
      const next = segments[i + 1];
      if (next && next.length > 0) {
        segments[i + 1] = ':id';
      }
    }
  }
  return `${m} ${segments.join('/')}`;
}

/** Record a single request. Bucketed by local-date + endpoint pattern. */
export function recordRequest(method: string, url: string, now: Date = new Date()): void {
  const key = today(now);
  const endpoint = normaliseEndpoint(method, url);
  const data = loadQuota();
  const bucket: DayBucket = data.days[key] ?? { total: 0, endpoints: {} };
  bucket.total += 1;
  bucket.endpoints[endpoint] = (bucket.endpoints[endpoint] ?? 0) + 1;
  data.days[key] = bucket;
  saveQuota(prune(data));
}

export function resetQuota(): void {
  const file = quotaFilePath();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // ignore
  }
}

/** Return today's usage (convenience for `quota status`). */
export function todayUsage(now: Date = new Date()): {
  date: string;
  total: number;
  remaining: number;
  endpoints: Record<string, number>;
} {
  const key = today(now);
  const data = loadQuota();
  const bucket = data.days[key] ?? { total: 0, endpoints: {} };
  return {
    date: key,
    total: bucket.total,
    remaining: Math.max(0, DAILY_QUOTA - bucket.total),
    endpoints: { ...bucket.endpoints },
  };
}
