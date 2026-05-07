import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simulateRule } from '../../src/rules/simulate.js';
import type { SimulateOptions } from '../../src/rules/simulate.js';
import type { Rule } from '../../src/rules/types.js';
import type { EngineEvent } from '../../src/rules/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    name: 'night-guard',
    when: { source: 'mqtt', event: 'motion.detected' },
    then: [{ command: 'turnOn', device: 'light' }],
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

function writeAgainstFile(filePath: string, events: EngineEvent[]): void {
  const lines = events.map(e => JSON.stringify({
    source: e.source,
    event: e.event,
    t: e.t.toISOString(),
    deviceId: e.deviceId,
  }));
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Against-file replay
// ---------------------------------------------------------------------------

describe('simulateRule — against file replay', () => {
  let againstFile: string;

  beforeEach(() => {
    againstFile = path.join(os.tmpdir(), `sim-against-${Date.now()}.jsonl`);
  });

  afterEach(() => {
    if (fs.existsSync(againstFile)) fs.unlinkSync(againstFile);
  });

  it('returns zero counts for empty event stream', async () => {
    writeAgainstFile(againstFile, []);
    const report = await simulateRule({ rule: makeRule(), against: againstFile });
    expect(report.sourceEventCount).toBe(0);
    expect(report.wouldFire).toBe(0);
    expect(report.blockedByCondition).toBe(0);
  });

  it('counts would-fire when trigger matches and no conditions', async () => {
    writeAgainstFile(againstFile, [makeEvent(), makeEvent(), makeEvent()]);
    const report = await simulateRule({ rule: makeRule(), against: againstFile });
    expect(report.sourceEventCount).toBe(3);
    expect(report.wouldFire).toBe(3);
    expect(report.blockedByCondition).toBe(0);
  });

  it('counts blocked-by-condition when time_between condition fails', async () => {
    const rule = makeRule({
      conditions: [{ time_between: ['22:00', '06:00'] }],
    });
    // Event at 08:00 — outside the 22:00-06:00 window
    const events = [makeEvent({ t: new Date('2026-05-07T08:00:00.000Z') })];
    writeAgainstFile(againstFile, events);
    const report = await simulateRule({ rule, against: againstFile });
    expect(report.wouldFire).toBe(0);
    expect(report.blockedByCondition).toBe(1);
  });

  it('counts would-fire when time_between condition passes', async () => {
    const rule = makeRule({
      conditions: [{ time_between: ['06:00', '20:00'] }],
    });
    const events = [makeEvent({ t: new Date('2026-05-07T08:00:00.000Z') })];
    writeAgainstFile(againstFile, events);
    const report = await simulateRule({ rule, against: againstFile });
    expect(report.wouldFire).toBe(1);
    expect(report.blockedByCondition).toBe(0);
  });

  it('filters events that do not match trigger event type', async () => {
    const rule = makeRule({ when: { source: 'mqtt', event: 'contact.opened' } });
    const events = [
      makeEvent({ event: 'motion.detected' }),
      makeEvent({ event: 'contact.opened' }),
    ];
    writeAgainstFile(againstFile, events);
    const report = await simulateRule({ rule, against: againstFile });
    // Only the contact.opened event should match
    expect(report.wouldFire).toBe(1);
    expect(report.blockedByCondition).toBe(0);
  });

  it('counts throttled events correctly', async () => {
    const rule = makeRule({ throttle: { max_per: '1h' } });
    const events = [
      makeEvent({ t: new Date('2026-05-07T08:00:00.000Z') }),
      makeEvent({ t: new Date('2026-05-07T08:30:00.000Z') }),  // within 1h window
      makeEvent({ t: new Date('2026-05-07T09:01:00.000Z') }),  // after window
    ];
    writeAgainstFile(againstFile, events);
    const report = await simulateRule({ rule, against: againstFile });
    expect(report.wouldFire).toBe(2);
    expect(report.throttled).toBe(1);
  });

  it('counts throttled with cooldown field', async () => {
    const rule = makeRule({ cooldown: '30m' });
    const events = [
      makeEvent({ t: new Date('2026-05-07T08:00:00.000Z') }),
      makeEvent({ t: new Date('2026-05-07T08:20:00.000Z') }), // within 30m
      makeEvent({ t: new Date('2026-05-07T08:31:00.000Z') }), // after cooldown
    ];
    writeAgainstFile(againstFile, events);
    const report = await simulateRule({ rule, against: againstFile });
    expect(report.wouldFire).toBe(2);
    expect(report.throttled).toBe(1);
  });

  it('report includes ruleName and ruleVersion', async () => {
    writeAgainstFile(againstFile, [makeEvent()]);
    const rule = makeRule();
    const report = await simulateRule({ rule, against: againstFile });
    expect(report.ruleName).toBe('night-guard');
    expect(report.ruleVersion).toMatch(/^[0-9a-f]{8}$/);
  });

  it('sampleFires contains entries with expected shape', async () => {
    writeAgainstFile(againstFile, [makeEvent()]);
    const report = await simulateRule({ rule: makeRule(), against: againstFile });
    expect(report.sampleFires).toHaveLength(1);
    const entry = report.sampleFires[0];
    expect(entry.decision).toBe('would-fire');
    expect(entry.fireId).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.t).toBe('2026-05-07T08:00:00.000Z');
  });

  it('topBlockReason shows most common failure', async () => {
    const rule = makeRule({ conditions: [{ time_between: ['22:00', '06:00'] }] });
    // Same timestamp → same failure message → one key with count 3
    const t = new Date('2026-05-07T08:00:00.000Z');
    const events = [makeEvent({ t }), makeEvent({ t }), makeEvent({ t })];
    writeAgainstFile(againstFile, events);
    const report = await simulateRule({ rule, against: againstFile });
    expect(report.blockedByCondition).toBe(3);
    expect(report.topBlockReason).toBeTruthy();
    expect(report.topBlockCount).toBeGreaterThan(0);
  });

  it('skips LLM condition and counts skippedLlm when liveLlm is false', async () => {
    const rule = makeRule({
      conditions: [{ llm: { prompt: 'Is it a good time?' } }],
    });
    writeAgainstFile(againstFile, [makeEvent()]);
    const report = await simulateRule({ rule, against: againstFile, liveLlm: false });
    expect(report.skippedLlm).toBe(1);
    expect(report.wouldFire).toBe(0);
    expect(report.sampleFires[0]?.decision).toBe('skipped-llm');
  });

  it('returns empty stream report when against file does not exist', async () => {
    const report = await simulateRule({ rule: makeRule(), against: '/no/such/file.jsonl' });
    expect(report.sourceEventCount).toBe(0);
  });

  it('sampleFires capped at 20 entries', async () => {
    const events = Array.from({ length: 30 }, (_, i) =>
      makeEvent({ t: new Date(`2026-05-07T${String(i % 24).padStart(2, '0')}:00:00.000Z`) }),
    );
    writeAgainstFile(againstFile, events);
    const report = await simulateRule({ rule: makeRule(), against: againstFile });
    expect(report.sampleFires.length).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// As-of state lookup
// ---------------------------------------------------------------------------

describe('simulateRule — device history as-of lookup', () => {
  const histDir = path.join(os.tmpdir(), `switchbot-hist-${Date.now()}`);
  let againstFile: string;

  beforeEach(() => {
    fs.mkdirSync(histDir, { recursive: true });
    againstFile = path.join(os.tmpdir(), `sim-hist-${Date.now()}.jsonl`);
  });

  afterEach(() => {
    if (fs.existsSync(againstFile)) fs.unlinkSync(againstFile);
    fs.rmSync(histDir, { recursive: true, force: true });
  });

  it('device_state condition uses empty status when device history not at default path', async () => {
    // deviceId uses alphanumeric-safe format to avoid Windows filename issues
    const deviceId = 'AABBCCDD';

    const rule = makeRule({
      conditions: [{ device: deviceId, field: 'openState', op: '==', value: 'CLOSE' }],
    });
    // Use a separate against file
    const testAgainstFile = path.join(os.tmpdir(), `sim-hist-against-${Date.now()}.jsonl`);
    try {
      writeAgainstFile(testAgainstFile, [makeEvent({ t: new Date('2026-05-07T08:00:00.000Z'), deviceId })]);
      const report = await simulateRule({ rule, against: testAgainstFile });
      // Without device history at the standard path, status is {} → openState is undefined
      // undefined == 'CLOSE' is false → blocked
      expect(report.sourceEventCount).toBe(1);
      expect(report.blockedByCondition).toBe(1);
    } finally {
      if (fs.existsSync(testAgainstFile)) fs.unlinkSync(testAgainstFile);
    }
  });
});

// ---------------------------------------------------------------------------
// Report output
// ---------------------------------------------------------------------------

describe('simulateRule — report output', () => {
  let againstFile: string;
  let reportOut: string;

  beforeEach(() => {
    againstFile = path.join(os.tmpdir(), `sim-out-${Date.now()}.jsonl`);
    reportOut = path.join(os.tmpdir(), `sim-report-${Date.now()}.json`);
  });

  afterEach(() => {
    if (fs.existsSync(againstFile)) fs.unlinkSync(againstFile);
    if (fs.existsSync(reportOut)) fs.unlinkSync(reportOut);
  });

  it('report has all expected fields', async () => {
    writeAgainstFile(againstFile, [makeEvent()]);
    const report = await simulateRule({ rule: makeRule(), against: againstFile });
    expect(typeof report.ruleName).toBe('string');
    expect(typeof report.ruleVersion).toBe('string');
    expect(report.windowStart).toBeInstanceOf(Date);
    expect(report.windowEnd).toBeInstanceOf(Date);
    expect(typeof report.sourceEventCount).toBe('number');
    expect(typeof report.wouldFire).toBe('number');
    expect(typeof report.blockedByCondition).toBe('number');
    expect(typeof report.throttled).toBe('number');
    expect(typeof report.errored).toBe('number');
    expect(typeof report.skippedLlm).toBe('number');
    expect(Array.isArray(report.sampleFires)).toBe(true);
    expect(Array.isArray(report.traces)).toBe(true);
  });

  it('window covers event timestamps', async () => {
    const t1 = new Date('2026-05-07T08:00:00.000Z');
    const t2 = new Date('2026-05-07T10:00:00.000Z');
    writeAgainstFile(againstFile, [makeEvent({ t: t1 }), makeEvent({ t: t2 })]);
    const report = await simulateRule({ rule: makeRule(), against: againstFile });
    expect(report.windowStart.getTime()).toBe(t1.getTime());
    expect(report.windowEnd.getTime()).toBe(t2.getTime());
  });

  it('ruleVersion is stable for same rule', async () => {
    writeAgainstFile(againstFile, [makeEvent()]);
    const r1 = await simulateRule({ rule: makeRule(), against: againstFile });
    const r2 = await simulateRule({ rule: makeRule(), against: againstFile });
    expect(r1.ruleVersion).toBe(r2.ruleVersion);
  });

  it('ruleVersion differs for different rule names', async () => {
    writeAgainstFile(againstFile, [makeEvent()]);
    const r1 = await simulateRule({ rule: makeRule({ name: 'rule-a' }), against: againstFile });
    const r2 = await simulateRule({ rule: makeRule({ name: 'rule-b' }), against: againstFile });
    expect(r1.ruleVersion).not.toBe(r2.ruleVersion);
  });
});
