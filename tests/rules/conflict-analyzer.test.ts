import { describe, it, expect } from 'vitest';
import { analyzeConflicts, HIGH_FREQ_EVENTS, isHighFreqEvent } from '../../src/rules/conflict-analyzer.js';
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

describe('analyzeConflicts — extractDeviceFromAction fallback', () => {
  it('detects opposing actions when device is embedded in command string (no device: field)', () => {
    const ruleOn: Rule = {
      name: 'strip-on',
      when: { source: 'cron', schedule: '0 8 * * *' },
      then: [{ command: 'devices command DEVICE123 turnOn' }],
    };
    const ruleOff: Rule = {
      name: 'strip-off',
      when: { source: 'cron', schedule: '0 8 * * *' },
      then: [{ command: 'devices command DEVICE123 turnOff' }],
    };
    const report = analyzeConflicts([ruleOn, ruleOff]);
    const finding = report.findings.find((f) => f.code === 'opposing-actions');
    expect(finding).toBeDefined();
    expect(finding?.rules).toContain('strip-on');
    expect(finding?.rules).toContain('strip-off');
  });

  it('does not flag opposing actions when command strings embed different device IDs', () => {
    const ruleOn: Rule = {
      name: 'on-device-a',
      when: { source: 'cron', schedule: '0 8 * * *' },
      then: [{ command: 'devices command DEVICE_A turnOn' }],
    };
    const ruleOff: Rule = {
      name: 'off-device-b',
      when: { source: 'cron', schedule: '0 8 * * *' },
      then: [{ command: 'devices command DEVICE_B turnOff' }],
    };
    const report = analyzeConflicts([ruleOn, ruleOff]);
    const finding = report.findings.find((f) => f.code === 'opposing-actions');
    expect(finding).toBeUndefined();
  });
});

describe('HIGH_FREQ_EVENTS and isHighFreqEvent', () => {
  it('device.shadow is considered high-frequency', () => {
    expect(isHighFreqEvent('device.shadow')).toBe(true);
  });

  it('wildcard * is considered high-frequency', () => {
    expect(isHighFreqEvent('*')).toBe(true);
  });

  it('motion.detected is NOT high-frequency (discrete conditional event)', () => {
    expect(isHighFreqEvent('motion.detected')).toBe(false);
  });

  it('HIGH_FREQ_EVENTS contains device.shadow and *', () => {
    expect(HIGH_FREQ_EVENTS).toContain('device.shadow');
    expect(HIGH_FREQ_EVENTS).toContain('*');
  });
});

describe('analyzeConflicts — high-frequency rules', () => {
  function shadowRule(name: string, extra: Partial<Rule> = {}): Rule {
    return {
      name,
      when: { source: 'mqtt', event: 'device.shadow' },
      then: [{ command: 'devices command DEVICE-1 turnOn', device: 'DEVICE-1' }],
      ...extra,
    };
  }

  it('flags device.shadow rule with no throttle as high-frequency-no-throttle warning', () => {
    const report = analyzeConflicts([shadowRule('no-throttle')]);
    const f = report.findings.filter((x) => x.code === 'high-frequency-no-throttle');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warning');
    expect(f[0].rules).toContain('no-throttle');
  });

  it('flags device.shadow rule with throttle < 30s as high-frequency-low-throttle info', () => {
    const rule = shadowRule('low-throttle', { throttle: { max_per: '10s' } });
    const report = analyzeConflicts([rule]);
    const f = report.findings.filter((x) => x.code === 'high-frequency-low-throttle');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('info');
  });

  it('does not flag device.shadow rule with throttle >= 5m', () => {
    const rule = shadowRule('well-throttled', { throttle: { max_per: '5m' } });
    const report = analyzeConflicts([rule]);
    const hfFindings = report.findings.filter(
      (x) => x.code === 'high-frequency-no-throttle' || x.code === 'high-frequency-low-throttle',
    );
    expect(hfFindings).toHaveLength(0);
  });

  it('does not flag motion.detected rule with no throttle', () => {
    const rule: Rule = {
      name: 'motion-no-throttle',
      when: { source: 'mqtt', event: 'motion.detected' },
      then: [{ command: 'devices command DEVICE-1 turnOn', device: 'DEVICE-1' }],
    };
    const report = analyzeConflicts([rule]);
    const hfFindings = report.findings.filter(
      (x) => x.code === 'high-frequency-no-throttle' || x.code === 'high-frequency-low-throttle',
    );
    expect(hfFindings).toHaveLength(0);
  });
});
