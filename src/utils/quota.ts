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
const FLUSH_DELAY_MS = 250;

let quotaCache: QuotaFile | null = null;
let loadedPath: string | null = null;
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;
let flushHooksRegistered = false;

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

function loadQuotaFromDisk(file: string): QuotaFile {
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

function saveQuota(data: QuotaFile, file = quotaFilePath()): void {
  const dir = path.dirname(file);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {
    // swallow: counting is best-effort, must not break a real API call
  }
}

function clearScheduledFlush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function syncLoadedQuota(): QuotaFile {
  const file = quotaFilePath();
  if (loadedPath !== file) {
    clearScheduledFlush();
    quotaCache = loadQuotaFromDisk(file);
    loadedPath = file;
    dirty = false;
  }
  if (!quotaCache) {
    quotaCache = loadQuotaFromDisk(file);
    loadedPath = file;
  }
  return quotaCache;
}

function ensureFlushHooks(): void {
  if (flushHooksRegistered) return;
  flushHooksRegistered = true;

  process.on('beforeExit', () => flushQuota());
  process.on('exit', () => flushQuota());
  // SIGINT/SIGTERM: attaching a listener suppresses Node's default terminate.
  // Flush the counter, then re-raise the conventional exit code (128 + signo).
  process.on('SIGINT', () => {
    flushQuota();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    flushQuota();
    process.exit(143);
  });
}

function scheduleFlush(): void {
  dirty = true;
  ensureFlushHooks();
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushQuota();
  }, FLUSH_DELAY_MS);
  flushTimer.unref?.();
}

export function loadQuota(): QuotaFile {
  return syncLoadedQuota();
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
  const data = syncLoadedQuota();
  const bucket: DayBucket = data.days[key] ?? { total: 0, endpoints: {} };
  bucket.total += 1;
  bucket.endpoints[endpoint] = (bucket.endpoints[endpoint] ?? 0) + 1;
  data.days[key] = bucket;
  quotaCache = prune(data);
  scheduleFlush();
}

export function flushQuota(): void {
  if (!dirty) return;
  const data = syncLoadedQuota();
  saveQuota(prune(data));
  dirty = false;
}

export function resetQuotaState(): void {
  clearScheduledFlush();
  quotaCache = null;
  loadedPath = null;
  dirty = false;
}

export function resetQuota(): void {
  resetQuotaState();
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

/**
 * Check whether today's call count is at or over the given cap. Returns the
 * current counter either way so callers can render a helpful refusal message.
 * Undefined cap → returns { over: false } without loading anything.
 */
export function checkDailyCap(
  dailyCap: number | undefined,
  now: Date = new Date(),
): { over: boolean; total: number; cap?: number; date: string } {
  const date = today(now);
  if (!dailyCap || dailyCap <= 0) {
    return { over: false, total: 0, date };
  }
  const data = loadQuota();
  const total = data.days[date]?.total ?? 0;
  return { over: total >= dailyCap, total, cap: dailyCap, date };
}
