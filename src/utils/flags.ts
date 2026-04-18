/**
 * Read global flags directly from process.argv (same pattern as isJsonMode).
 * Kept simple so subcommand actions don't need to thread program.opts() down.
 */

function getFlagValue(...flagNames: string[]): string | undefined {
  for (const flag of flagNames) {
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < process.argv.length) {
      return process.argv[idx + 1];
    }
  }
  return undefined;
}

export function isVerbose(): boolean {
  return process.argv.includes('--verbose') || process.argv.includes('-v');
}

export function isDryRun(): boolean {
  return process.argv.includes('--dry-run');
}

/** HTTP request timeout in milliseconds. Default 30s. */
export function getTimeout(): number {
  const v = getFlagValue('--timeout');
  if (!v) return 30_000;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 30_000;
  return n;
}

/** Override for the credentials file path. */
export function getConfigPath(): string | undefined {
  return getFlagValue('--config');
}

/** Named profile → ~/.switchbot/profiles/<name>.json. */
export function getProfile(): string | undefined {
  return getFlagValue('--profile');
}

/**
 * Audit log path. `--audit-log <path>` enables JSONL append on every mutating
 * command; default path is ~/.switchbot/audit.log when `--audit-log` is given
 * without a value. Returns null when the flag is absent.
 */
export function getAuditLog(): string | null {
  const idx = process.argv.indexOf('--audit-log');
  if (idx === -1) return null;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith('-')) {
    // bare --audit-log → default location
    return `${process.env.HOME ?? process.env.USERPROFILE ?? '.'}/.switchbot/audit.log`;
  }
  return next;
}

/**
 * Max 429 retries before surfacing the error. Default 3. `--no-retry`
 * disables retries entirely; `--retry-on-429 <n>` overrides the count.
 */
export function getRetryOn429(): number {
  if (process.argv.includes('--no-retry')) return 0;
  const v = getFlagValue('--retry-on-429');
  if (v === undefined) return 3;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 3;
  return Math.floor(n);
}

/** Backoff strategy for 429 retries. Default 'exponential'. */
export function getBackoffStrategy(): 'linear' | 'exponential' {
  const v = getFlagValue('--backoff');
  if (v === 'linear') return 'linear';
  return 'exponential';
}

/**
 * Whether local quota counting is disabled. Quota counting is best-effort
 * (see src/utils/quota.ts) — this lets scripts opt out entirely when even
 * best-effort file I/O is unwelcome.
 */
export function isQuotaDisabled(): boolean {
  return process.argv.includes('--no-quota');
}

/**
 * Cache TTL controls. Values:
 *   - `--no-cache`                 → disable cache for all reads
 *   - `--cache off`                → same as `--no-cache`
 *   - `--cache auto` (default)     → list cache on (1h), status cache off
 *   - `--cache 5m` | `--cache 1h`  → enable both stores with the given TTL
 *   - numeric millisecond values are also accepted
 */
export interface CacheMode {
  /** TTL for the device-list cache, in ms. 0/undefined = off. */
  listTtlMs: number;
  /** TTL for the device-status cache, in ms. 0/undefined = off. */
  statusTtlMs: number;
}

const DEFAULT_LIST_TTL_MS = 60 * 60 * 1000;

function parseDurationToMs(v: string): number | null {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(v.trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2] ?? 'ms';
  switch (unit) {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    default: return null;
  }
}

export { parseDurationToMs };

/** The --format flag value, or undefined when absent. */
export function getFormat(): string | undefined {
  return getFlagValue('--format');
}

/** Comma-separated --fields value, split into an array. */
export function getFields(): string[] | undefined {
  const v = getFlagValue('--fields');
  if (!v) return undefined;
  return v.split(',').map((f) => f.trim()).filter(Boolean);
}

export function getCacheMode(): CacheMode {
  if (process.argv.includes('--no-cache')) {
    return { listTtlMs: 0, statusTtlMs: 0 };
  }
  const v = getFlagValue('--cache');
  if (!v || v === 'auto') {
    return { listTtlMs: DEFAULT_LIST_TTL_MS, statusTtlMs: 0 };
  }
  if (v === 'off') {
    return { listTtlMs: 0, statusTtlMs: 0 };
  }
  const ms = parseDurationToMs(v);
  if (ms === null || ms === 0) {
    return { listTtlMs: DEFAULT_LIST_TTL_MS, statusTtlMs: 0 };
  }
  return { listTtlMs: ms, statusTtlMs: ms };
}
