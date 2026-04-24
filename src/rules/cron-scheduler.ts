/**
 * Cron trigger scheduler for the rules engine.
 *
 * Each cron rule gets its own scheduler entry. On every tick the
 * scheduler synthesises an `EngineEvent` with `source: 'cron'` and hands
 * it to the same dispatch path the MQTT pipeline uses, so conditions,
 * throttle, and action execution behave identically regardless of
 * trigger source.
 *
 * Tests can drive the scheduler deterministically via `fireNowForTest()`
 * — the scheduler's internal timer still uses `setTimeout`, which means
 * `vi.useFakeTimers()` plus `vi.advanceTimersByTime()` also work. Croner
 * is used only for `nextRun(fromDate)` calculations; we own the
 * timer/dispatch loop so the engine can drain events through a single
 * serialised queue.
 */

import { Cron } from 'croner';
import type { EngineEvent, Rule, DayOfWeek } from './types.js';

/** Maps JS getDay() (0=Sun) to 3-letter abbreviation. */
const JS_DAY_TO_ABBR = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** Expand a days[] entry to its canonical 3-letter abbr so comparisons are O(1). */
function normaliseDay(d: DayOfWeek): string {
  return d.toLowerCase().slice(0, 3);
}

/** Return true if `t` falls on one of the listed days (or days is absent/empty). */
export function matchesDayFilter(days: DayOfWeek[] | undefined, t: Date): boolean {
  if (!days || days.length === 0) return true;
  const todayAbbr = JS_DAY_TO_ABBR[t.getDay()];
  return days.some((d) => normaliseDay(d) === todayAbbr);
}

export interface CronDispatch {
  (rule: Rule, event: EngineEvent): Promise<void>;
}

export interface CronSchedulerOptions {
  /** Dispatch callback — the engine's queue wrapper that runs the rule. */
  dispatch: CronDispatch;
  /** Clock injection for tests; defaults to Date.now. */
  now?: () => Date;
}

interface Scheduled {
  rule: Rule;
  schedule: string;
  pattern: Cron;
  timer: NodeJS.Timeout | null;
  nextAt: Date | null;
}

export class CronScheduler {
  private readonly opts: CronSchedulerOptions;
  private readonly entries = new Map<string, Scheduled>();
  private started = false;
  private stopped = false;

  constructor(opts: CronSchedulerOptions) {
    this.opts = opts;
  }

  getScheduledFor(ruleName: string): { schedule: string; nextAt: Date | null } | null {
    const s = this.entries.get(ruleName);
    if (!s) return null;
    return { schedule: s.schedule, nextAt: s.nextAt };
  }

  hasRegistered(ruleName: string): boolean {
    return this.entries.has(ruleName);
  }

  /**
   * Register a cron rule. Validates the pattern eagerly — an invalid
   * schedule throws synchronously so engine start can surface the error.
   */
  register(rule: Rule): void {
    if (rule.when.source !== 'cron') {
      throw new Error(`CronScheduler.register called for non-cron rule "${rule.name}"`);
    }
    if (this.entries.has(rule.name)) {
      throw new Error(`CronScheduler: duplicate rule name "${rule.name}"`);
    }
    const schedule = rule.when.schedule;
    let pattern: Cron;
    try {
      pattern = new Cron(schedule, { paused: true });
    } catch (err) {
      throw new Error(
        `CronScheduler: invalid cron expression for rule "${rule.name}": ${schedule} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const entry: Scheduled = {
      rule,
      schedule,
      pattern,
      timer: null,
      nextAt: null,
    };
    this.entries.set(rule.name, entry);
    if (this.started && !this.stopped) this.arm(entry);
  }

  unregister(ruleName: string): void {
    const e = this.entries.get(ruleName);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    try {
      e.pattern.stop();
    } catch {
      // croner throws when already stopped — ignore.
    }
    this.entries.delete(ruleName);
  }

  start(): void {
    if (this.stopped) {
      throw new Error('CronScheduler: cannot start after stop().');
    }
    if (this.started) return;
    this.started = true;
    for (const entry of this.entries.values()) this.arm(entry);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    for (const e of this.entries.values()) {
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      try {
        e.pattern.stop();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Test helper — compute the pattern's next run after a reference
   * timestamp without actually scheduling it. Handy for regression tests.
   */
  nextRunAfter(ruleName: string, after: Date): Date | null {
    const e = this.entries.get(ruleName);
    if (!e) return null;
    return e.pattern.nextRun(after) ?? null;
  }

  /**
   * Test helper — fire a rule immediately, bypassing the timer. Used by
   * unit tests to skip vi.advanceTimersByTime logic when the focus is on
   * dispatch behaviour, not scheduling accuracy.
   */
  async fireNowForTest(ruleName: string): Promise<void> {
    const e = this.entries.get(ruleName);
    if (!e) throw new Error(`CronScheduler.fireNowForTest: no rule "${ruleName}"`);
    await this.fire(e);
  }

  private nowDate(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private arm(entry: Scheduled): void {
    if (this.stopped) return;
    const now = this.nowDate();
    const next = entry.pattern.nextRun(now);
    if (!next) {
      entry.nextAt = null;
      return;
    }
    entry.nextAt = next;
    const delayMs = Math.max(0, next.getTime() - now.getTime());
    entry.timer = setTimeout(() => {
      entry.timer = null;
      // Fire and then re-arm, regardless of outcome — we never want one
      // misbehaving rule to kill its own future ticks.
      this.fire(entry)
        .catch(() => undefined)
        .finally(() => {
          if (!this.stopped && this.entries.has(entry.rule.name)) this.arm(entry);
        });
    }, delayMs);
    // Unref so a process with only cron rules still exits on SIGINT when
    // the user expects (e.g. in integration tests).
    if (typeof (entry.timer as unknown as { unref?: () => void }).unref === 'function') {
      (entry.timer as unknown as { unref: () => void }).unref();
    }
  }

  private async fire(entry: Scheduled): Promise<void> {
    const when = this.nowDate();
    // Apply the optional day-of-week filter before dispatching.
    const trigger = entry.rule.when;
    if (trigger.source === 'cron' && !matchesDayFilter(trigger.days, when)) {
      return;
    }
    const event: EngineEvent = {
      source: 'cron',
      event: entry.schedule,
      t: when,
      payload: { schedule: entry.schedule },
    };
    await this.opts.dispatch(entry.rule, event);
  }
}
