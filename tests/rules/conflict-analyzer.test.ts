import { describe, it, expect } from 'vitest';
import { analyzeConflicts } from '../../src/rules/conflict-analyzer.js';
import type { Rule } from '../../src/rules/types.js';

function mqttRule(name: string, extra: Partial<Rule> = {}): Rule {
  return {
    name,
    when: { source: 'mqtt', event: 'motion.detected' },
    then: [{ command: 'devices command LAMP turnOn', device: 'LAMP' }],
    ...extra,
  };
}

function webhookRule(name: string, extra: Partial<Rule> = {}): Rule {
  return {
    name,
    when: { source: 'webhook', path: '/motion' },
    then: [{ command: 'devices command LAMP turnOn', device: 'LAMP' }],
    ...extra,
  };
}

function cronRule(name: string, extra: Partial<Rule> = {}): Rule {
  return {
    name,
    when: { source: 'cron', schedule: '0 22 * * *' },
    then: [{ command: 'devices command LAMP turnOff', device: 'LAMP' }],
    ...extra,
  };
}

describe('analyzeConflicts — quiet-hours gap detection', () => {
  const quietHours = { start: '22:00', end: '07:00' };

  it('returns no findings when quietHours is not provided', () => {
    const report = analyzeConflicts([mqttRule('r1')]);
    const qhFindings = report.findings.filter((f) => f.code === 'no-quiet-hours-guard');
    expect(qhFindings).toHaveLength(0);
  });

  it('flags mqtt rule with no time_between condition when quietHours is set', () => {
    const report = analyzeConflicts([mqttRule('r1')], quietHours);
    const qhFindings = report.findings.filter((f) => f.code === 'no-quiet-hours-guard');
    expect(qhFindings).toHaveLength(1);
    expect(qhFindings[0].rules).toContain('r1');
    expect(qhFindings[0].severity).toBe('warning');
    expect(qhFindings[0].message).toContain('22:00–07:00');
  });

  it('flags webhook rule with no time_between condition when quietHours is set', () => {
    const report = analyzeConflicts([webhookRule('wh1')], quietHours);
    const qhFindings = report.findings.filter((f) => f.code === 'no-quiet-hours-guard');
    expect(qhFindings).toHaveLength(1);
    expect(qhFindings[0].rules).toContain('wh1');
  });

  it('does not flag a rule that has a top-level time_between condition', () => {
    const r = mqttRule('guarded', {
      conditions: [{ time_between: ['07:00', '22:00'] }],
    });
    const report = analyzeConflicts([r], quietHours);
    const qhFindings = report.findings.filter((f) => f.code === 'no-quiet-hours-guard');
    expect(qhFindings).toHaveLength(0);
  });

  it('does not flag a time_between inside an all-condition (nested guard)', () => {
    const r = mqttRule('nested', {
      conditions: [{ all: [{ time_between: ['07:00', '22:00'] }] }],
    });
    const report = analyzeConflicts([r], quietHours);
    const qhFindings = report.findings.filter((f) => f.code === 'no-quiet-hours-guard');
    expect(qhFindings).toHaveLength(0);
  });

  it('does not flag cron rules (schedule-driven, not event-driven)', () => {
    const report = analyzeConflicts([cronRule('nightly')], quietHours);
    const qhFindings = report.findings.filter((f) => f.code === 'no-quiet-hours-guard');
    expect(qhFindings).toHaveLength(0);
  });

  it('does not flag disabled rules', () => {
    const r = mqttRule('disabled-r', { enabled: false });
    const report = analyzeConflicts([r], quietHours);
    const qhFindings = report.findings.filter((f) => f.code === 'no-quiet-hours-guard');
    expect(qhFindings).toHaveLength(0);
  });

  it('hint contains an actionable time_between snippet', () => {
    const report = analyzeConflicts([mqttRule('r1')], quietHours);
    const f = report.findings.find((x) => x.code === 'no-quiet-hours-guard');
    expect(f?.hint).toContain('time_between');
    expect(f?.hint).toContain('07:00');
    expect(f?.hint).toContain('22:00');
  });
});
