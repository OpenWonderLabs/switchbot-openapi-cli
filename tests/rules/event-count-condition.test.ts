import { describe, it, expect } from 'vitest';
import { evaluateConditions, type EventWindowFetcher } from '../../src/rules/matcher.js';
import type { EngineEvent } from '../../src/rules/types.js';

function makeEvent(overrides: Partial<EngineEvent> = {}): EngineEvent {
  return {
    source: 'mqtt',
    event: 'motion.detected',
    t: new Date('2026-05-15T08:00:00.000Z'),
    deviceId: 'AA:BB:CC',
    ...overrides,
  };
}

function fetcherWithEvents(events: EngineEvent[]): EventWindowFetcher {
  return async (deviceId, opts) => {
    return events.filter((e) => {
      if (e.deviceId !== deviceId) return false;
      const tMs = e.t.getTime();
      if (tMs < opts.sinceMs || tMs > opts.untilMs) return false;
      if (opts.eventName && e.event !== opts.eventName) return false;
      return true;
    });
  };
}

function buildEvents(deviceId: string, eventName: string, timestamps: string[]): EngineEvent[] {
  return timestamps.map((iso) => ({
    source: 'mqtt' as const,
    event: eventName,
    t: new Date(iso),
    deviceId,
  }));
}

describe('event_count condition', () => {
  it('matches when count is within [min, max]', async () => {
    const now = new Date('2026-05-15T08:00:00.000Z');
    const fetcher = fetcherWithEvents(
      buildEvents('AA:BB:CC', 'motion.detected', [
        '2026-05-15T07:56:00.000Z',
        '2026-05-15T07:57:00.000Z',
        '2026-05-15T07:58:00.000Z',
      ]),
    );

    const result = await evaluateConditions(
      [{ event_count: { device: 'AA:BB:CC', event: 'motion.detected', window: '5m', min: 3 } }],
      now,
      { eventWindowFetcher: fetcher },
    );

    expect(result.matched).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('fails when count is below min', async () => {
    const now = new Date('2026-05-15T08:00:00.000Z');
    const fetcher = fetcherWithEvents(
      buildEvents('AA:BB:CC', 'motion.detected', [
        '2026-05-15T07:56:00.000Z',
        '2026-05-15T07:57:00.000Z',
      ]),
    );

    const result = await evaluateConditions(
      [{ event_count: { device: 'AA:BB:CC', event: 'motion.detected', window: '5m', min: 3 } }],
      now,
      { eventWindowFetcher: fetcher },
    );

    expect(result.matched).toBe(false);
    expect(result.failures[0]).toContain('event_count');
    expect(result.failures[0]).toContain('2');
  });

  it('fails when count exceeds max', async () => {
    const now = new Date('2026-05-15T08:00:00.000Z');
    const fetcher = fetcherWithEvents(
      buildEvents('AA:BB:CC', 'motion.detected', [
        '2026-05-15T07:55:00.000Z',
        '2026-05-15T07:56:00.000Z',
        '2026-05-15T07:57:00.000Z',
        '2026-05-15T07:58:00.000Z',
        '2026-05-15T07:59:00.000Z',
      ]),
    );

    const result = await evaluateConditions(
      [{ event_count: { device: 'AA:BB:CC', event: 'motion.detected', window: '5m', min: 1, max: 3 } }],
      now,
      { eventWindowFetcher: fetcher },
    );

    expect(result.matched).toBe(false);
    expect(result.failures[0]).toContain('event_count');
  });

  it('only counts events inside the rolling window', async () => {
    const now = new Date('2026-05-15T08:00:00.000Z');
    const fetcher = fetcherWithEvents(
      buildEvents('AA:BB:CC', 'motion.detected', [
        '2026-05-15T07:00:00.000Z', // outside 5m window
        '2026-05-15T07:30:00.000Z', // outside 5m window
        '2026-05-15T07:58:00.000Z', // inside
      ]),
    );

    const result = await evaluateConditions(
      [{ event_count: { device: 'AA:BB:CC', event: 'motion.detected', window: '5m', min: 3 } }],
      now,
      { eventWindowFetcher: fetcher },
    );

    expect(result.matched).toBe(false);
  });

  it('omits the event filter when "event" is not specified', async () => {
    const now = new Date('2026-05-15T08:00:00.000Z');
    const events: EngineEvent[] = [
      ...buildEvents('AA:BB:CC', 'motion.detected', ['2026-05-15T07:58:00.000Z']),
      ...buildEvents('AA:BB:CC', 'contact.opened', ['2026-05-15T07:59:00.000Z']),
    ];
    const fetcher = fetcherWithEvents(events);

    const result = await evaluateConditions(
      [{ event_count: { device: 'AA:BB:CC', window: '5m', min: 2 } }],
      now,
      { eventWindowFetcher: fetcher },
    );

    expect(result.matched).toBe(true);
  });

  it('flags as unsupported when no eventWindowFetcher is provided', async () => {
    const now = new Date('2026-05-15T08:00:00.000Z');

    const result = await evaluateConditions(
      [{ event_count: { device: 'AA:BB:CC', window: '5m', min: 1 } }],
      now,
      {},
    );

    expect(result.matched).toBe(false);
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0].keyword).toBe('event_count');
  });

  it('rejects malformed window strings as fail', async () => {
    const now = new Date('2026-05-15T08:00:00.000Z');
    const fetcher = fetcherWithEvents([]);

    const result = await evaluateConditions(
      [{ event_count: { device: 'AA:BB:CC', window: 'oops', min: 1 } }],
      now,
      { eventWindowFetcher: fetcher },
    );

    expect(result.matched).toBe(false);
    expect(result.failures[0]).toContain('window');
  });

  it('resolves alias to deviceId before fetching', async () => {
    const now = new Date('2026-05-15T08:00:00.000Z');
    const fetcher = fetcherWithEvents(
      buildEvents('AA:BB:CC', 'motion.detected', [
        '2026-05-15T07:58:00.000Z',
      ]),
    );

    const result = await evaluateConditions(
      [{ event_count: { device: 'front-door', event: 'motion.detected', window: '5m', min: 1 } }],
      now,
      {
        aliases: { 'front-door': 'AA:BB:CC' },
        eventWindowFetcher: fetcher,
      },
    );

    expect(result.matched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// event_count condition lints
// ---------------------------------------------------------------------------

describe('event_count condition lints', () => {
  it('condition-event-count-bad-window fires for malformed window', async () => {
    const { lintRules } = await import('../../src/rules/engine.js');
    const result = lintRules({
      enabled: true,
      rules: [{
        name: 'test',
        when: { source: 'mqtt', event: 'motion.detected' },
        conditions: [{ event_count: { device: 'AA:BB:CC', window: 'forever', min: 3 } }],
        then: [{ command: 'turnOn', device: 'light' }],
      }],
    });
    const issues = result.rules[0].issues;
    expect(issues.some((i) => i.code === 'condition-event-count-bad-window')).toBe(true);
  });

  it('condition-event-count-max-below-min fires when max < min', async () => {
    const { lintRules } = await import('../../src/rules/engine.js');
    const result = lintRules({
      enabled: true,
      rules: [{
        name: 'test',
        when: { source: 'mqtt', event: 'motion.detected' },
        conditions: [{ event_count: { device: 'AA:BB:CC', window: '5m', min: 5, max: 2 } }],
        then: [{ command: 'turnOn', device: 'light' }],
      }],
    });
    const issues = result.rules[0].issues;
    expect(issues.some((i) => i.code === 'condition-event-count-max-below-min')).toBe(true);
  });

  it('event_count with valid window and ranges does not lint', async () => {
    const { lintRules } = await import('../../src/rules/engine.js');
    const result = lintRules({
      enabled: true,
      rules: [{
        name: 'test',
        when: { source: 'mqtt', event: 'motion.detected' },
        conditions: [{ event_count: { device: 'AA:BB:CC', window: '5m', min: 3, max: 10 } }],
        then: [{ command: 'turnOn', device: 'light' }],
      }],
    });
    const issues = result.rules[0].issues;
    expect(issues.some((i) => i.code?.startsWith('condition-event-count'))).toBe(false);
  });
});
