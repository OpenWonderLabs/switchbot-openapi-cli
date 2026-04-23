import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../../src/utils/audit.js';
import {
  aggregateRuleAudits,
  filterRuleAudits,
  RULE_AUDIT_KINDS,
} from '../../src/rules/audit-query.js';

function entry(partial: Partial<AuditEntry>): AuditEntry {
  return {
    auditVersion: 2,
    t: '2026-04-23T10:00:00.000Z',
    kind: 'rule-fire',
    deviceId: 'AA-BB-CC',
    command: 'devices command AA-BB-CC turnOn',
    parameter: null,
    commandType: 'command',
    dryRun: false,
    ...partial,
  };
}

function ruleBlock(
  name: string,
  extra: Partial<NonNullable<AuditEntry['rule']>> = {},
): NonNullable<AuditEntry['rule']> {
  return {
    name,
    triggerSource: 'mqtt',
    fireId: 'f-1',
    ...extra,
  };
}

describe('filterRuleAudits', () => {
  it('keeps only rule-* kinds by default', () => {
    const input: AuditEntry[] = [
      entry({ kind: 'command' }),
      entry({ kind: 'rule-fire', rule: ruleBlock('alpha') }),
      entry({ kind: 'rule-fire-dry', rule: ruleBlock('beta') }),
      entry({ kind: 'rule-throttled', rule: ruleBlock('alpha') }),
    ];
    const out = filterRuleAudits(input);
    expect(out.map((e) => e.kind)).toEqual([
      'rule-fire',
      'rule-fire-dry',
      'rule-throttled',
    ]);
  });

  it('drops entries older than sinceMs', () => {
    const input: AuditEntry[] = [
      entry({ t: '2026-04-01T00:00:00.000Z', rule: ruleBlock('old') }),
      entry({ t: '2026-04-23T09:00:00.000Z', rule: ruleBlock('recent') }),
    ];
    const cutoff = Date.parse('2026-04-20T00:00:00.000Z');
    const out = filterRuleAudits(input, { sinceMs: cutoff });
    expect(out.map((e) => e.rule?.name)).toEqual(['recent']);
  });

  it('filters by rule name exactly', () => {
    const input: AuditEntry[] = [
      entry({ rule: ruleBlock('alpha') }),
      entry({ rule: ruleBlock('beta') }),
      entry({ rule: ruleBlock('alphabeta') }),
    ];
    const out = filterRuleAudits(input, { ruleName: 'alpha' });
    expect(out.map((e) => e.rule?.name)).toEqual(['alpha']);
  });

  it('honours a custom kinds set', () => {
    const input: AuditEntry[] = [
      entry({ kind: 'rule-fire', rule: ruleBlock('a') }),
      entry({ kind: 'rule-fire-dry', rule: ruleBlock('a') }),
    ];
    const out = filterRuleAudits(input, { kinds: ['rule-fire-dry'] });
    expect(out.map((e) => e.kind)).toEqual(['rule-fire-dry']);
  });

  it('exports RULE_AUDIT_KINDS covering every engine-emitted kind', () => {
    expect(RULE_AUDIT_KINDS).toContain('rule-fire');
    expect(RULE_AUDIT_KINDS).toContain('rule-fire-dry');
    expect(RULE_AUDIT_KINDS).toContain('rule-throttled');
    expect(RULE_AUDIT_KINDS).toContain('rule-webhook-rejected');
  });
});

describe('aggregateRuleAudits', () => {
  it('groups by rule name and counts fires / dries / throttled / errors', () => {
    const input: AuditEntry[] = [
      entry({
        t: '2026-04-23T10:00:00.000Z',
        kind: 'rule-fire',
        result: 'ok',
        rule: ruleBlock('alpha'),
      }),
      entry({
        t: '2026-04-23T10:05:00.000Z',
        kind: 'rule-fire',
        result: 'error',
        rule: ruleBlock('alpha'),
      }),
      entry({
        t: '2026-04-23T10:10:00.000Z',
        kind: 'rule-fire-dry',
        rule: ruleBlock('alpha'),
      }),
      entry({
        t: '2026-04-23T10:15:00.000Z',
        kind: 'rule-throttled',
        rule: ruleBlock('alpha'),
      }),
      entry({
        t: '2026-04-23T10:20:00.000Z',
        kind: 'rule-fire-dry',
        rule: ruleBlock('beta'),
      }),
    ];
    const report = aggregateRuleAudits(input);
    expect(report.total).toBe(5);
    expect(report.summaries).toHaveLength(2);

    const alpha = report.summaries.find((s) => s.rule === 'alpha')!;
    expect(alpha.fires).toBe(2);
    expect(alpha.driesFires).toBe(1);
    expect(alpha.throttled).toBe(1);
    expect(alpha.errors).toBe(1);
    // errorRate = errors / (fires + dries) = 1/3 ≈ 0.333
    expect(alpha.errorRate).toBeCloseTo(1 / 3, 5);
    expect(alpha.firstAt).toBe('2026-04-23T10:00:00.000Z');
    expect(alpha.lastAt).toBe('2026-04-23T10:15:00.000Z');
    expect(alpha.triggerSource).toBe('mqtt');

    const beta = report.summaries.find((s) => s.rule === 'beta')!;
    expect(beta.fires).toBe(0);
    expect(beta.driesFires).toBe(1);
    expect(beta.errors).toBe(0);
    expect(beta.errorRate).toBe(0);
  });

  it('sorts summaries by (fires + dries) descending', () => {
    const input: AuditEntry[] = [
      entry({ kind: 'rule-fire-dry', rule: ruleBlock('quiet') }),
      entry({ kind: 'rule-fire', rule: ruleBlock('loud'), result: 'ok' }),
      entry({ kind: 'rule-fire', rule: ruleBlock('loud'), result: 'ok' }),
      entry({ kind: 'rule-fire-dry', rule: ruleBlock('loud') }),
    ];
    const report = aggregateRuleAudits(input);
    expect(report.summaries.map((s) => s.rule)).toEqual(['loud', 'quiet']);
  });

  it('reports triggerSource as "mixed" when a name spans sources', () => {
    const input: AuditEntry[] = [
      entry({ kind: 'rule-fire', rule: ruleBlock('poly', { triggerSource: 'mqtt' }) }),
      entry({ kind: 'rule-fire-dry', rule: ruleBlock('poly', { triggerSource: 'cron' }) }),
    ];
    const report = aggregateRuleAudits(input);
    expect(report.summaries[0].triggerSource).toBe('mixed');
  });

  it('buckets unparented webhook rejections into webhookRejectedCount', () => {
    const input: AuditEntry[] = [
      entry({ kind: 'rule-webhook-rejected', error: 'unauthorized' }),
      entry({ kind: 'rule-webhook-rejected', error: 'unknown-path' }),
      entry({ kind: 'rule-fire-dry', rule: ruleBlock('alpha') }),
    ];
    const report = aggregateRuleAudits(input);
    expect(report.webhookRejectedCount).toBe(2);
    expect(report.summaries.map((s) => s.rule)).toEqual(['alpha']);
  });

  it('ignores entries with no rule block that are not webhook-rejected', () => {
    const input: AuditEntry[] = [
      entry({ kind: 'rule-throttled', rule: undefined }),
    ];
    const report = aggregateRuleAudits(input);
    expect(report.summaries).toHaveLength(0);
    expect(report.webhookRejectedCount).toBe(0);
  });
});
