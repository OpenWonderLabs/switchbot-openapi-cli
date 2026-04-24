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
 *
 * Circuit breaker:
 *   Prevents hammering a consistently-failing endpoint. Tracks consecutive
 *   failures; when `failureThreshold` is exceeded the circuit opens and
 *   subsequent calls fail immediately (with CircuitOpenError). After
 *   `resetTimeoutMs` the circuit enters half-open state: the next call is
 *   allowed as a probe — success closes it, failure re-opens it.
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

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before the circuit opens. Default: 5. */
  failureThreshold?: number;
  /** Milliseconds to keep the circuit open before entering half-open. Default: 60_000. */
  resetTimeoutMs?: number;
}

/**
 * Thrown when a call is blocked because the circuit is open.
 */
export class CircuitOpenError extends Error {
  constructor(
    public readonly circuitName: string,
    public readonly nextAttemptMs: number,
  ) {
    super(`Circuit "${circuitName}" is open — too many recent failures. Next probe allowed in ${Math.ceil((nextAttemptMs - Date.now()) / 1000)}s.`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastOpenedAt = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(
    public readonly name: string,
    opts: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 60_000;
  }

  getState(): CircuitState {
    this._maybeHalfOpen();
    return this.state;
  }

  getStats(): { state: CircuitState; failures: number; lastOpenedAt: number; nextProbeMs: number } {
    this._maybeHalfOpen();
    return {
      state: this.state,
      failures: this.failures,
      lastOpenedAt: this.lastOpenedAt,
      nextProbeMs: this.state === 'open' ? this.lastOpenedAt + this.resetTimeoutMs : 0,
    };
  }

  /**
   * Check if a call is allowed. Throws `CircuitOpenError` when the circuit
   * is open and the reset timeout hasn't elapsed. Call `recordSuccess()` or
   * `recordFailure()` after the operation completes.
   */
  checkAndAllow(): void {
    this._maybeHalfOpen();
    if (this.state === 'open') {
      throw new CircuitOpenError(this.name, this.lastOpenedAt + this.resetTimeoutMs);
    }
    // closed or half-open: allow the call
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.failures++;
    if (this.state === 'half-open' || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.lastOpenedAt = Date.now();
    }
  }

  /** Reset to closed — useful for testing or manual recovery. */
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.lastOpenedAt = 0;
  }

  private _maybeHalfOpen(): void {
    if (
      this.state === 'open' &&
      Date.now() >= this.lastOpenedAt + this.resetTimeoutMs
    ) {
      this.state = 'half-open';
    }
  }
}
