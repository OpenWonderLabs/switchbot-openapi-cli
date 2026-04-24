/**
 * Throttle gate — per-rule, optionally keyed by deviceId.
 *
 * Semantics:
 *   - `max_per: "10m"` → a rule may fire at most once every 10 minutes
 *     per (rule, deviceId) pair.
 *   - `dedupe_window: "5s"` → suppress fires whose key already fired
 *     within the window (collapses rapid sensor bursts into one action).
 *   - Fires that would violate the window are **suppressed** (not
 *     queued) and surface as `{ allowed: false, reason: 'throttled' }`.
 *   - When a rule has no `throttle` block, `ThrottleGate.check` returns
 *     `{ allowed: true }` immediately.
 *
 * The gate is in-memory only. Re-reads between processes (or after
 * SIGHUP reload) start with a clean slate — a deliberate choice,
 * because persisting throttle state would lock the engine into a
 * schema that changes every time we add a trigger type.
 */

const DURATION_RE = /^(\d+)([smh])$/;

export function parseMaxPerMs(expr: string): number {
  const m = DURATION_RE.exec(expr.trim());
  if (!m) throw new Error(`Invalid throttle.max_per: "${expr}"`);
  const n = Number(m[1]);
  const unit = m[2];
  const unitMs = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000;
  return n * unitMs;
}

export interface ThrottleCheckResult {
  allowed: boolean;
  /** Timestamp of the last fire that occupies the window, if any. */
  lastFiredAt?: number;
  /** When the window will reopen. */
  nextAllowedAt?: number;
  /** Whether this was blocked by the dedupe_window (vs max_per). */
  dedupedBy?: 'dedupe_window' | 'max_per' | 'cooldown';
}

export class ThrottleGate {
  private lastFireAt = new Map<string, number>();

  private keyOf(ruleName: string, deviceId?: string): string {
    return deviceId ? `${ruleName}::${deviceId}` : ruleName;
  }

  /**
   * Does **not** record the fire. Call `record()` after the action
   * actually runs so that dry-run / throttled paths don't bump the
   * window.
   */
  check(
    ruleName: string,
    windowMs: number | null,
    now: number,
    deviceId?: string,
    dedupeWindowMs?: number | null,
  ): ThrottleCheckResult {
    const key = this.keyOf(ruleName, deviceId);
    const last = this.lastFireAt.get(key);

    // dedupe_window check: suppress if last fire was within this (typically smaller) window
    if (dedupeWindowMs !== null && dedupeWindowMs !== undefined && dedupeWindowMs > 0) {
      if (last !== undefined) {
        const dedupeEnd = last + dedupeWindowMs;
        if (now < dedupeEnd) {
          return { allowed: false, lastFiredAt: last, nextAllowedAt: dedupeEnd, dedupedBy: 'dedupe_window' };
        }
      }
    }

    // max_per / cooldown check
    if (windowMs === null || windowMs <= 0) return { allowed: true, lastFiredAt: last };
    if (last === undefined) return { allowed: true };
    const earliest = last + windowMs;
    if (now >= earliest) return { allowed: true, lastFiredAt: last };
    return { allowed: false, lastFiredAt: last, nextAllowedAt: earliest, dedupedBy: windowMs > 0 ? 'max_per' : undefined };
  }

  record(ruleName: string, now: number, deviceId?: string): void {
    this.lastFireAt.set(this.keyOf(ruleName, deviceId), now);
  }

  /** Drop everything — used by engine.reload when a rule is removed. */
  forget(ruleName: string): void {
    const prefix = `${ruleName}::`;
    for (const k of this.lastFireAt.keys()) {
      if (k === ruleName || k.startsWith(prefix)) this.lastFireAt.delete(k);
    }
  }

  /**
   * Drop every window whose rule name isn't in the given set — used by
   * `engine.reload` after a policy swap. Entries for names that survive
   * the reload are preserved so unchanged rules don't get a free
   * one-fire amnesty.
   */
  retainOnly(ruleNames: Set<string>): void {
    for (const k of this.lastFireAt.keys()) {
      const sep = k.indexOf('::');
      const ruleName = sep === -1 ? k : k.slice(0, sep);
      if (!ruleNames.has(ruleName)) this.lastFireAt.delete(k);
    }
  }

  /** Test helper — exposes the underlying size. */
  size(): number {
    return this.lastFireAt.size;
  }
}
