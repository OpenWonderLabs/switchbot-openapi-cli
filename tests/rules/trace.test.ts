import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalizeRule,
  ruleVersion,
  TraceBuilder,
  shouldWriteTrace,
  filterTraceRecords,
  HIGH_FREQ_EVENTS,
  type EvaluateTraceMode,
  type TraceDecision,
  type RuleEvaluateRecord,
} from '../../src/rules/trace.js';
import type { Rule, EngineEvent } from '../../src/rules/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    name: 'test-rule',
    when: { source: 'mqtt', event: 'motion.detected' },
    then: [{ command: 'turnOn', device: 'light-1' }],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EngineEvent> = {}): EngineEvent {
  return {
    source: 'mqtt',
    event: 'motion.detected',
    t: new Date('2026-05-07T08:00:00.000Z'),
    deviceId: 'AA:BB:CC',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// canonicalizeRule
// ---------------------------------------------------------------------------

describe('canonicalizeRule', () => {
  it('produces the same output regardless of key insertion order', () => {
    const rule1 = makeRule({ name: 'alpha', dry_run: true });
    const rule2 = { dry_run: true, name: 'alpha', when: rule1.when, then: rule1.then } as Rule;
    expect(canonicalizeRule(rule1)).toBe(canonicalizeRule(rule2));
  });

  it('produces different output when a field value changes', () => {
    const a = makeRule({ name: 'rule-a' });
    const b = makeRule({ name: 'rule-b' });
    expect(canonicalizeRule(a)).not.toBe(canonicalizeRule(b));
  });

  it('handles nested objects (trigger, conditions) stably', () => {
    const r = makeRule({
      when: { source: 'mqtt', event: 'contact.opened', device: 'door' },
      conditions: [{ time_between: ['22:00', '06:00'] }],
    });
    const canon = canonicalizeRule(r);
    expect(canon).toContain('"time_between"');
    expect(typeof JSON.parse(canon)).toBe('object');
  });

  it('handles arrays in stable order (array order is preserved)', () => {
    const r1 = makeRule({ then: [{ command: 'turnOn' }, { command: 'turnOff' }] });
    const r2 = makeRule({ then: [{ command: 'turnOn' }, { command: 'turnOff' }] });
    expect(canonicalizeRule(r1)).toBe(canonicalizeRule(r2));
  });
});

// ---------------------------------------------------------------------------
// ruleVersion
// ---------------------------------------------------------------------------

describe('ruleVersion', () => {
  it('returns an 8-character hex string', () => {
    const v = ruleVersion(makeRule());
    expect(v).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is identical for rules that differ only in key ordering', () => {
    const a = makeRule({ name: 'night-light' });
    const b = { name: 'night-light', when: a.when, then: a.then } as Rule;
    expect(ruleVersion(a)).toBe(ruleVersion(b));
  });

  it('differs when a field changes', () => {
    const a = makeRule({ name: 'rule-1' });
    const b = makeRule({ name: 'rule-2' });
    expect(ruleVersion(a)).not.toBe(ruleVersion(b));
  });

  it('differs when throttle is added', () => {
    const base = makeRule();
    const throttled = makeRule({ throttle: { max_per: '10m' } });
    expect(ruleVersion(base)).not.toBe(ruleVersion(throttled));
  });
});

// ---------------------------------------------------------------------------
// TraceBuilder
// ---------------------------------------------------------------------------

describe('TraceBuilder', () => {
  const decisions: TraceDecision[] = ['fire', 'dry', 'throttled', 'blocked-by-condition', 'error'];

  for (const decision of decisions) {
    it(`builds a valid record for decision="${decision}"`, () => {
      const rule = makeRule();
      const event = makeEvent();
      const fireId = 'fire-id-123';
      const builder = new TraceBuilder();
      builder.push({ kind: 'time_between', config: ['22:00', '06:00'], passed: true });

      const record = builder.build(rule, event, fireId, decision);

      expect(record.kind).toBe('rule-evaluate');
      expect(record.rule.name).toBe('test-rule');
      expect(record.rule.version).toMatch(/^[0-9a-f]{8}$/);
      expect(record.trigger.source).toBe('mqtt');
      expect(record.trigger.event).toBe('motion.detected');
      expect(record.trigger.deviceId).toBe('AA:BB:CC');
      expect(record.fireId).toBe(fireId);
      expect(record.decision).toBe(decision);
      expect(record.conditions).toHaveLength(1);
      expect(record.conditions[0].kind).toBe('time_between');
      expect(record.conditions[0].passed).toBe(true);
      expect(record.evaluationMs).toBeGreaterThanOrEqual(0);
      expect(() => new Date(record.t)).not.toThrow();
    });
  }

  it('marks short-circuited condition with passed: null', () => {
    const builder = new TraceBuilder();
    builder.push({ kind: 'time_between', passed: true });
    builder.push({ kind: 'device_state', passed: null }); // short-circuited

    const record = builder.build(makeRule(), makeEvent(), 'id', 'blocked-by-condition');
    expect(record.conditions[1].passed).toBeNull();
  });

  it('snapshot of returned conditions is independent from further pushes', () => {
    const builder = new TraceBuilder();
    builder.push({ kind: 'time_between', passed: true });
    const record = builder.build(makeRule(), makeEvent(), 'id', 'fire');
    builder.push({ kind: 'device_state', passed: false }); // pushed after build
    expect(record.conditions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// shouldWriteTrace
// ---------------------------------------------------------------------------

describe('shouldWriteTrace', () => {
  const highFreqEvent = makeEvent({ event: 'motion.detected' });
  const lowFreqEvent = makeEvent({ event: 'button.pressed' });

  it('off → never writes', () => {
    for (const d of ['fire', 'dry', 'throttled', 'blocked-by-condition', 'error'] as TraceDecision[]) {
      expect(shouldWriteTrace('off', highFreqEvent, d)).toBe(false);
    }
  });

  it('full → always writes', () => {
    for (const d of ['fire', 'dry', 'throttled', 'blocked-by-condition', 'error'] as TraceDecision[]) {
      expect(shouldWriteTrace('full', highFreqEvent, d)).toBe(true);
    }
  });

  it('sampled: suppresses high-freq + blocked-by-condition', () => {
    expect(shouldWriteTrace('sampled', highFreqEvent, 'blocked-by-condition')).toBe(false);
  });

  it('sampled: writes high-freq + fire', () => {
    expect(shouldWriteTrace('sampled', highFreqEvent, 'fire')).toBe(true);
  });

  it('sampled: writes high-freq + throttled', () => {
    expect(shouldWriteTrace('sampled', highFreqEvent, 'throttled')).toBe(true);
  });

  it('sampled: always writes low-freq events regardless of decision', () => {
    for (const d of ['fire', 'dry', 'throttled', 'blocked-by-condition', 'error'] as TraceDecision[]) {
      expect(shouldWriteTrace('sampled', lowFreqEvent, d)).toBe(true);
    }
  });

  it('HIGH_FREQ_EVENTS covers device.shadow, motion.detected, motion.cleared', () => {
    expect(HIGH_FREQ_EVENTS.has('device.shadow')).toBe(true);
    expect(HIGH_FREQ_EVENTS.has('motion.detected')).toBe(true);
    expect(HIGH_FREQ_EVENTS.has('motion.cleared')).toBe(true);
    expect(HIGH_FREQ_EVENTS.has('button.pressed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterTraceRecords
// ---------------------------------------------------------------------------

describe('filterTraceRecords', () => {
  function makeRecord(overrides: Partial<RuleEvaluateRecord> = {}): RuleEvaluateRecord {
    return {
      t: '2026-05-07T08:00:00.000Z',
      kind: 'rule-evaluate',
      rule: { name: 'night-light', version: 'abc12345' },
      trigger: { source: 'mqtt', event: 'motion.detected', deviceId: 'AA:BB' },
      fireId: 'fire-1',
      conditions: [],
      decision: 'fire',
      evaluationMs: 10,
      ...overrides,
    };
  }

  function toLines(records: RuleEvaluateRecord[]): string[] {
    return records.map((r) => JSON.stringify(r));
  }

  it('returns all rule-evaluate records when no filter applied', () => {
    const records = [makeRecord(), makeRecord({ fireId: 'fire-2' })];
    const result = filterTraceRecords(toLines(records));
    expect(result).toHaveLength(2);
  });

  it('skips non-rule-evaluate lines', () => {
    const lines = [
      JSON.stringify({ kind: 'rule-fire', t: '2026-05-07T08:00:00.000Z' }),
      JSON.stringify(makeRecord()),
    ];
    const result = filterTraceRecords(lines);
    expect(result).toHaveLength(1);
  });

  it('skips malformed lines', () => {
    const lines = ['not-json', JSON.stringify(makeRecord())];
    const result = filterTraceRecords(lines);
    expect(result).toHaveLength(1);
  });

  it('filters by fireId', () => {
    const records = [makeRecord({ fireId: 'A' }), makeRecord({ fireId: 'B' })];
    const result = filterTraceRecords(toLines(records), { fireId: 'A' });
    expect(result).toHaveLength(1);
    expect(result[0].fireId).toBe('A');
  });

  it('filters by ruleName', () => {
    const records = [
      makeRecord({ rule: { name: 'night-light', version: 'v1' } }),
      makeRecord({ rule: { name: 'morning-scene', version: 'v2' } }),
    ];
    const result = filterTraceRecords(toLines(records), { ruleName: 'night-light' });
    expect(result).toHaveLength(1);
    expect(result[0].rule.name).toBe('night-light');
  });

  it('filters by since (ISO string)', () => {
    const records = [
      makeRecord({ t: '2026-05-06T00:00:00.000Z' }),
      makeRecord({ t: '2026-05-07T08:00:00.000Z' }),
    ];
    const result = filterTraceRecords(toLines(records), { since: '2026-05-07T00:00:00.000Z' });
    expect(result).toHaveLength(1);
    expect(result[0].t).toBe('2026-05-07T08:00:00.000Z');
  });

  it('noFireOnly excludes fire and dry decisions', () => {
    const records = [
      makeRecord({ decision: 'fire' }),
      makeRecord({ decision: 'dry' }),
      makeRecord({ decision: 'blocked-by-condition' }),
      makeRecord({ decision: 'throttled' }),
    ];
    const result = filterTraceRecords(toLines(records), { noFireOnly: true });
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.decision !== 'fire' && r.decision !== 'dry')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: write + read back via writeEvaluateTrace
// ---------------------------------------------------------------------------

describe('writeEvaluateTrace integration', () => {
  let auditFile: string;

  beforeEach(() => {
    auditFile = path.join(os.tmpdir(), `trace-test-${Date.now()}.log`);
  });

  afterEach(() => {
    if (fs.existsSync(auditFile)) fs.unlinkSync(auditFile);
  });

  it('round-trips a record through the audit file', async () => {
    const { writeEvaluateTrace } = await import('../../src/utils/audit.js');
    const builder = new TraceBuilder();
    builder.push({ kind: 'time_between', config: ['22:00', '06:00'], passed: true });
    const rule = makeRule({ name: 'night-light' });
    const record = builder.build(rule, makeEvent(), 'fire-xyz', 'fire');

    writeEvaluateTrace(record, auditFile);

    const lines = fs.readFileSync(auditFile, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as RuleEvaluateRecord;
    expect(parsed.kind).toBe('rule-evaluate');
    expect(parsed.rule.name).toBe('night-light');
    expect(parsed.fireId).toBe('fire-xyz');
    expect(parsed.decision).toBe('fire');
    expect(parsed.conditions[0].kind).toBe('time_between');
  });
});
