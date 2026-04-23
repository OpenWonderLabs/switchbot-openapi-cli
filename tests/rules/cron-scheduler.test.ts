import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { CronScheduler } from '../../src/rules/cron-scheduler.js';
import type { Rule, EngineEvent } from '../../src/rules/types.js';

function cronRule(name: string, schedule: string): Rule {
  return {
    name,
    when: { source: 'cron', schedule },
    then: [{ command: 'devices command <id> turnOn', device: 'lamp' }],
    dry_run: true,
  };
}

describe('CronScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers and unregisters rules', () => {
    const scheduler = new CronScheduler({ dispatch: async () => undefined });
    const r = cronRule('a', '0 * * * *');
    scheduler.register(r);
    expect(scheduler.getScheduledFor('a')).not.toBeNull();
    scheduler.unregister('a');
    expect(scheduler.getScheduledFor('a')).toBeNull();
  });

  it('throws when registering a non-cron rule', () => {
    const scheduler = new CronScheduler({ dispatch: async () => undefined });
    const wrong: Rule = {
      name: 'mqtt',
      when: { source: 'mqtt', event: 'motion.detected' },
      then: [{ command: 'devices command <id> turnOn', device: 'lamp' }],
    };
    expect(() => scheduler.register(wrong)).toThrow(/non-cron/);
  });

  it('throws when registering an invalid cron expression', () => {
    const scheduler = new CronScheduler({ dispatch: async () => undefined });
    expect(() => scheduler.register(cronRule('bad', 'not a cron'))).toThrow(/invalid cron/);
  });

  it('rejects duplicate rule names', () => {
    const scheduler = new CronScheduler({ dispatch: async () => undefined });
    scheduler.register(cronRule('dup', '0 * * * *'));
    expect(() => scheduler.register(cronRule('dup', '0 * * * *'))).toThrow(/duplicate/);
  });

  it('nextRunAfter returns a future date for a valid pattern', () => {
    const scheduler = new CronScheduler({ dispatch: async () => undefined });
    scheduler.register(cronRule('hourly', '0 * * * *'));
    const anchor = new Date('2026-04-23T12:34:00Z');
    const next = scheduler.nextRunAfter('hourly', anchor);
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(anchor.getTime());
  });

  it('fireNowForTest dispatches synthetic cron event to the callback', async () => {
    const events: Array<{ rule: Rule; event: EngineEvent }> = [];
    const scheduler = new CronScheduler({
      dispatch: async (rule, event) => {
        events.push({ rule, event });
      },
    });
    const r = cronRule('kitchen lights', '0 22 * * *');
    scheduler.register(r);
    await scheduler.fireNowForTest('kitchen lights');
    expect(events).toHaveLength(1);
    expect(events[0].rule.name).toBe('kitchen lights');
    expect(events[0].event.source).toBe('cron');
    expect(events[0].event.event).toBe('0 22 * * *');
  });

  it('fireNowForTest throws for an unknown rule name', async () => {
    const scheduler = new CronScheduler({ dispatch: async () => undefined });
    await expect(scheduler.fireNowForTest('nope')).rejects.toThrow(/no rule/);
  });

  it('start + advance timers fires when the schedule is due', async () => {
    vi.useFakeTimers();
    // Anchor to Jan 1 2026 10:00 local. Using local-time constructor so
    // the croner "minute 0" calculation lines up with the fake clock.
    vi.setSystemTime(new Date(2026, 0, 1, 10, 0, 0));
    const events: Array<{ rule: Rule; event: EngineEvent }> = [];
    const scheduler = new CronScheduler({
      dispatch: async (rule, event) => {
        events.push({ rule, event });
      },
    });
    // Every 5 minutes schedule — the next run from 10:00 local is 10:05.
    scheduler.register(cronRule('every5', '*/5 * * * *'));
    scheduler.start();
    // Fast-forward just under 5 minutes — should not have fired yet.
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(events).toHaveLength(0);
    // Fast-forward past the 5-minute mark.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    // Drain any microtasks that the dispatch chain enqueues.
    await vi.advanceTimersByTimeAsync(0);
    expect(events.length).toBeGreaterThanOrEqual(1);
    scheduler.stop();
  });

  it('stop() clears pending timers so no future fires happen', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 10, 0, 0));
    const events: Array<{ rule: Rule; event: EngineEvent }> = [];
    const scheduler = new CronScheduler({
      dispatch: async (rule, event) => {
        events.push({ rule, event });
      },
    });
    scheduler.register(cronRule('hourly', '0 * * * *'));
    scheduler.start();
    scheduler.stop();
    // Jump two hours — nothing should fire because the scheduler stopped.
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(events).toHaveLength(0);
  });

  it('cannot start after stop()', () => {
    const scheduler = new CronScheduler({ dispatch: async () => undefined });
    scheduler.register(cronRule('hourly', '0 * * * *'));
    scheduler.stop();
    expect(() => scheduler.start()).toThrow(/cannot start after stop/);
  });

  it('registering after start() arms the new rule immediately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 10, 0, 0));
    const events: Array<{ rule: Rule; event: EngineEvent }> = [];
    const scheduler = new CronScheduler({
      dispatch: async (rule, event) => {
        events.push({ rule, event });
      },
    });
    scheduler.start();
    scheduler.register(cronRule('late join', '*/5 * * * *'));
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.length).toBeGreaterThanOrEqual(1);
    scheduler.stop();
  });
});
