import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadTraceRecords,
  loadRelatedAudit,
  formatExplainText,
  formatExplainJson,
} from '../../src/rules/explain.js';
import { writeEvaluateTrace } from '../../src/utils/audit.js';
import { TraceBuilder, ruleVersion } from '../../src/rules/trace.js';
import type { RuleEvaluateRecord } from '../../src/rules/trace.js';
import type { Rule, EngineEvent } from '../../src/rules/types.js';
import type { AuditEntry } from '../../src/utils/audit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(): Rule {
  return {
    name: 'night-light',
    when: { source: 'mqtt', event: 'motion.detected' },
    then: [{ command: 'turnOn', device: 'light' }],
  };
}

function makeEvent(): EngineEvent {
  return {
    source: 'mqtt',
    event: 'motion.detected',
    t: new Date('2026-05-07T08:30:14.122Z'),
    deviceId: 'AB:CD:EF',
  };
}

function makeTraceRecord(overrides: Partial<RuleEvaluateRecord> = {}): RuleEvaluateRecord {
  const rule = makeRule();
  return {
    t: '2026-05-07T08:30:14.122Z',
    kind: 'rule-evaluate',
    rule: { name: rule.name, version: ruleVersion(rule) },
    trigger: { source: 'mqtt', event: 'motion.detected', deviceId: 'AB:CD:EF' },
    fireId: 'test-fire-id',
    conditions: [],
    decision: 'fire',
    evaluationMs: 14,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// loadTraceRecords
// ---------------------------------------------------------------------------

describe('loadTraceRecords', () => {
  let auditFile: string;

  beforeEach(() => {
    auditFile = path.join(os.tmpdir(), `explain-test-${Date.now()}.log`);
  });

  afterEach(() => {
    if (fs.existsSync(auditFile)) fs.unlinkSync(auditFile);
  });

  it('returns empty array when file does not exist', () => {
    expect(loadTraceRecords('/nonexistent/path.log')).toEqual([]);
  });

  it('returns trace records from audit file', () => {
    const record = makeTraceRecord();
    writeEvaluateTrace(record, auditFile);
    const results = loadTraceRecords(auditFile);
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('rule-evaluate');
  });

  it('filters by ruleName', () => {
    writeEvaluateTrace(makeTraceRecord({ rule: { name: 'rule-a', version: 'v1' } }), auditFile);
    writeEvaluateTrace(makeTraceRecord({ rule: { name: 'rule-b', version: 'v2' } }), auditFile);
    const results = loadTraceRecords(auditFile, { ruleName: 'rule-a' });
    expect(results).toHaveLength(1);
    expect(results[0].rule.name).toBe('rule-a');
  });

  it('filters by since', () => {
    writeEvaluateTrace(makeTraceRecord({ t: '2026-05-06T00:00:00.000Z' }), auditFile);
    writeEvaluateTrace(makeTraceRecord({ t: '2026-05-07T08:00:00.000Z' }), auditFile);
    const results = loadTraceRecords(auditFile, { since: '2026-05-07T00:00:00.000Z' });
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// loadRelatedAudit
// ---------------------------------------------------------------------------

describe('loadRelatedAudit', () => {
  let auditFile: string;

  beforeEach(() => {
    auditFile = path.join(os.tmpdir(), `explain-related-${Date.now()}.log`);
  });

  afterEach(() => {
    if (fs.existsSync(auditFile)) fs.unlinkSync(auditFile);
  });

  it('returns empty when file missing', () => {
    expect(loadRelatedAudit('/no/such/file.log', 'any-id')).toEqual([]);
  });

  it('returns audit entries sharing the same fireId via rule.fireId', () => {
    const entry: AuditEntry = {
      auditVersion: 2,
      t: '2026-05-07T08:30:14.122Z',
      kind: 'rule-fire',
      deviceId: 'AB:CD',
      command: 'turnOn',
      parameter: null,
      commandType: 'command',
      dryRun: false,
      rule: { name: 'night-light', triggerSource: 'mqtt', fireId: 'my-fire-id' },
    };
    fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n');

    const results = loadRelatedAudit(auditFile, 'my-fire-id');
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('rule-fire');
  });

  it('does not return entries with a different fireId', () => {
    const entry: AuditEntry = {
      auditVersion: 2,
      t: '2026-05-07T08:30:14.122Z',
      kind: 'rule-fire',
      deviceId: 'AB:CD',
      command: 'turnOn',
      parameter: null,
      commandType: 'command',
      dryRun: false,
      rule: { name: 'night-light', triggerSource: 'mqtt', fireId: 'other-fire-id' },
    };
    fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n');
    expect(loadRelatedAudit(auditFile, 'my-fire-id')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatExplainText — golden snapshots per decision kind
// ---------------------------------------------------------------------------

describe('formatExplainText', () => {
  const baseRecord = makeTraceRecord({
    conditions: [
      { kind: 'time_between', config: ['22:00', '06:00'], passed: true },
      { kind: 'device_state', config: { device: 'front-door', field: 'contact', op: '==', value: 'closed' }, passed: false },
    ],
  });

  it('fire: contains rule name, trigger, decision', () => {
    const text = formatExplainText({ ...baseRecord, decision: 'fire' }, []);
    expect(text).toContain('night-light');
    expect(text).toContain('motion.detected');
    expect(text).toContain('Decision: fire');
    expect(text).toContain('✓ time_between');
  });

  it('blocked-by-condition: shows failed condition', () => {
    const text = formatExplainText({ ...baseRecord, decision: 'blocked-by-condition' }, []);
    expect(text).toContain('Decision: blocked-by-condition');
    expect(text).toContain('✗ device_state');
    expect(text).toContain('failed');
  });

  it('throttled: contains throttled decision', () => {
    const text = formatExplainText({ ...baseRecord, decision: 'throttled' }, []);
    expect(text).toContain('Decision: throttled');
  });

  it('dry: contains dry decision', () => {
    const text = formatExplainText({ ...baseRecord, decision: 'dry' }, []);
    expect(text).toContain('Decision: dry');
  });

  it('error: contains error decision', () => {
    const text = formatExplainText({ ...baseRecord, decision: 'error' }, []);
    expect(text).toContain('Decision: error');
  });

  it('renders short-circuited condition with · symbol', () => {
    const record = makeTraceRecord({
      conditions: [
        { kind: 'time_between', passed: true },
        { kind: 'device_state', passed: null }, // short-circuited
      ],
    });
    const text = formatExplainText(record, []);
    expect(text).toContain('· device_state');
    expect(text).toContain('not evaluated (short-circuited)');
  });

  it('shows audit trail when related records are present', () => {
    const related: AuditEntry[] = [{
      auditVersion: 2,
      t: '2026-05-07T08:30:15.000Z',
      kind: 'rule-fire',
      deviceId: 'AB:CD',
      command: 'turnOn',
      parameter: null,
      commandType: 'command',
      dryRun: false,
      rule: { name: 'night-light', triggerSource: 'mqtt', fireId: 'test-fire-id' },
    }];
    const text = formatExplainText(baseRecord, related);
    expect(text).toContain('Audit trail');
    expect(text).toContain('rule-fire');
  });

  it('shows "no related records" note when no related audit entries', () => {
    const text = formatExplainText({ ...baseRecord, decision: 'blocked-by-condition' }, []);
    expect(text).toContain('Audit trail');
    expect(text).toContain('rule did not fire');
  });

  it('includes fireId', () => {
    const text = formatExplainText(baseRecord, []);
    expect(text).toContain('test-fire-id');
  });
});

// ---------------------------------------------------------------------------
// formatExplainJson
// ---------------------------------------------------------------------------

describe('formatExplainJson', () => {
  it('returns parseable JSON with trace and relatedAudit fields', () => {
    const record = makeTraceRecord();
    const json = formatExplainJson(record, []);
    const parsed = JSON.parse(json) as { trace: RuleEvaluateRecord; relatedAudit: unknown[] };
    expect(parsed.trace.kind).toBe('rule-evaluate');
    expect(parsed.relatedAudit).toEqual([]);
  });

  it('includes related audit entries', () => {
    const related: AuditEntry[] = [{
      auditVersion: 2,
      t: '2026-05-07T08:30:15.000Z',
      kind: 'rule-fire',
      deviceId: 'AB:CD',
      command: 'turnOn',
      parameter: null,
      commandType: 'command',
      dryRun: false,
    }];
    const json = formatExplainJson(makeTraceRecord(), related);
    const parsed = JSON.parse(json) as { relatedAudit: unknown[] };
    expect(parsed.relatedAudit).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// trace-disabled scenario
// ---------------------------------------------------------------------------

describe('trace disabled scenario', () => {
  it('loadTraceRecords returns empty array when no rule-evaluate records exist', () => {
    const tmpFile = path.join(os.tmpdir(), `no-trace-${Date.now()}.log`);
    const entry: AuditEntry = {
      auditVersion: 2,
      t: '2026-05-07T08:00:00.000Z',
      kind: 'rule-fire',
      deviceId: 'X',
      command: 'turnOn',
      parameter: null,
      commandType: 'command',
      dryRun: false,
    };
    fs.appendFileSync(tmpFile, JSON.stringify(entry) + '\n');
    const results = loadTraceRecords(tmpFile);
    expect(results).toHaveLength(0);
    fs.unlinkSync(tmpFile);
  });
});
