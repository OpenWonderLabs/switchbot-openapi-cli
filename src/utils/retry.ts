/**
 * Retry/backoff helpers for the axios client. Kept as pure functions so
 * tests can pin attempt → delay without wall-clock sleeping.
 *
 * Backoff strategies:
 *   linear       → 1s, 2s, 3s, ... (cap 30s)
 *   exponential  → 1s, 2s, 4s, 8s, 16s (cap 30s)  [default]
 *
 * If the server returns a `Retry-After` header we always prefer it over our
 * own backoff — the API explicitly told us when to come back.
 */

export type BackoffStrategy = 'linear' | 'exponential';

const BASE_MS = 1_000;
const MAX_MS = 30_000;

/**
 * Parse an HTTP `Retry-After` header. Supports both the seconds form
 * ("Retry-After: 42") and the HTTP-date form ("Retry-After: Wed, 21 Oct
 * 2015 07:28:00 GMT"). Returns the delay in ms, or undefined on garbage.
 */
export function parseRetryAfter(header: unknown, now: number = Date.now()): number | undefined {
  if (typeof header !== 'string') return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;

  // All-digits → seconds.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.min(seconds * 1000, MAX_MS);
  }

  // HTTP-date.
  const ts = Date.parse(trimmed);
  if (!Number.isFinite(ts)) return undefined;
  const delta = ts - now;
  if (delta <= 0) return 0;
  return Math.min(delta, MAX_MS);
}

/** Compute the next backoff delay (ms) for a given attempt index (0-based). */
export function computeBackoff(attempt: number, strategy: BackoffStrategy): number {
  const safe = Math.max(0, attempt);
  if (strategy === 'linear') {
    return Math.min((safe + 1) * BASE_MS, MAX_MS);
  }
  // exponential
  return Math.min(BASE_MS * Math.pow(2, safe), MAX_MS);
}

/** Resolve the delay to use before the next retry, preferring Retry-After. */
export function nextRetryDelayMs(
  attempt: number,
  strategy: BackoffStrategy,
  retryAfterHeader: unknown,
  now: number = Date.now()
): number {
  const fromHeader = parseRetryAfter(retryAfterHeader, now);
  if (fromHeader !== undefined) return fromHeader;
  return computeBackoff(attempt, strategy);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
