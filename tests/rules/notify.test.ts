import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeNotifyAction, renderNotifyTemplate } from '../../src/rules/notify.js';
import type { NotifyAction } from '../../src/rules/types.js';
import { readAudit } from '../../src/utils/audit.js';
import type { Rule } from '../../src/rules/types.js';

const baseRule: Rule = {
  name: 'motion-alert',
  when: { source: 'mqtt', event: 'motion.detected' },
  then: [],
};

function fileAction(to: string, extra: Partial<NotifyAction> = {}): NotifyAction {
  return { type: 'notify', channel: 'file', to, ...extra };
}

function webhookAction(to: string, extra: Partial<NotifyAction> = {}): NotifyAction {
  return { type: 'notify', channel: 'webhook', to, ...extra };
}

describe('renderNotifyTemplate', () => {
  it('substitutes {{ rule.name }}', () => {
    const result = renderNotifyTemplate('Rule {{ rule.name }} fired', { 'rule.name': 'ac-on-when-hot' });
    expect(result).toBe('Rule ac-on-when-hot fired');
  });

  it('substitutes multiple variables in one string', () => {
    const result = renderNotifyTemplate('{{ rule.name }} on {{ device.id }}', {
      'rule.name': 'my-rule',
      'device.id': 'DEV_001',
    });
    expect(result).toBe('my-rule on DEV_001');
  });

  it('leaves unknown placeholders unchanged', () => {
    const result = renderNotifyTemplate('{{ unknown.var }} stays', {});
    expect(result).toBe('{{ unknown.var }} stays');
  });

  it('handles template with no placeholders', () => {
    const result = renderNotifyTemplate('plain text', { 'rule.name': 'x' });
    expect(result).toBe('plain text');
  });

  it('substitutes nested dot-path keys (event.context.deviceMac)', () => {
    const result = renderNotifyTemplate('{{ event.context.deviceMac }}@{{ event.list.0 }}', {
      'event.context.deviceMac': 'AA:BB:CC',
      'event.list.0': 'first',
    });
    expect(result).toBe('AA:BB:CC@first');
  });
});

describe('executeNotifyAction — file channel', () => {
  let tmpDir: string;
  let auditLog: string;
  const originalArgv = process.argv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notify-m2-'));
    auditLog = path.join(tmpDir, 'audit.log');
    process.argv = ['node', 'cli', '--audit-log', '--audit-log-path', auditLog];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.argv = originalArgv;
  });

  it('appends a JSON line to the target file', async () => {
    const target = path.join(tmpDir, 'events.jsonl');
    const result = await executeNotifyAction(fileAction(target), {
      rule: baseRule,
      fireId: 'fire-001',
      eventPayload: { temperature: 29 },
      deviceId: 'METER_001',
    });

    expect(result.ok).toBe(true);
    expect(result.channel).toBe('file');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const lines = fs.readFileSync(target, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.rule).toBe('motion-alert');
    expect(parsed.fireId).toBe('fire-001');
  });

  it('creates parent directory if it does not exist', async () => {
    const target = path.join(tmpDir, 'subdir', 'events.jsonl');
    const result = await executeNotifyAction(fileAction(target), {
      rule: baseRule,
      fireId: 'fire-002',
      eventPayload: {},
      deviceId: 'DEV_001',
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('appends multiple lines on repeated calls', async () => {
    const target = path.join(tmpDir, 'events.jsonl');
    await executeNotifyAction(fileAction(target), { rule: baseRule, fireId: 'f1', eventPayload: {}, deviceId: 'd' });
    await executeNotifyAction(fileAction(target), { rule: baseRule, fireId: 'f2', eventPayload: {}, deviceId: 'd' });

    const lines = fs.readFileSync(target, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('renders custom template when provided', async () => {
    const target = path.join(tmpDir, 'events.jsonl');
    await executeNotifyAction(
      fileAction(target, { template: '{{ rule.name }}:{{ device.id }}' }),
      { rule: baseRule, fireId: 'f3', eventPayload: {}, deviceId: 'DEV_ABC' },
    );

    const line = fs.readFileSync(target, 'utf-8').trim();
    expect(line).toBe('motion-alert:DEV_ABC');
  });

  it('renders nested event.* paths and array indexes from payload', async () => {
    const target = path.join(tmpDir, 'events.jsonl');
    await executeNotifyAction(
      fileAction(target, { template: '{{ event.context.deviceMac }}-{{ event.list.0 }}-{{ event.context.detectionState }}' }),
      {
        rule: baseRule,
        fireId: 'f-nested',
        eventPayload: {
          context: { deviceMac: 'AA:BB:CC:DD:EE:FF', detectionState: 'DETECTED' },
          list: ['alpha', 'beta'],
        },
        deviceId: 'DEV_NEST',
      },
    );

    const line = fs.readFileSync(target, 'utf-8').trim();
    expect(line).toBe('AA:BB:CC:DD:EE:FF-alpha-DETECTED');
  });

  it('writes a rule-notify audit entry on success', async () => {
    const target = path.join(tmpDir, 'events.jsonl');
    await executeNotifyAction(fileAction(target), {
      rule: baseRule,
      fireId: 'fire-audit',
      eventPayload: {},
      deviceId: 'DEV_001',
    });

    const entries = readAudit(auditLog);
    const entry = entries.find(e => e.kind === 'rule-notify');
    expect(entry).toBeDefined();
    expect(entry!.result).toBe('ok');
    expect(entry!.notifyChannel).toBe('file');
    expect(entry!.notifyLatencyMs).toBeGreaterThanOrEqual(0);
    expect(entry!.rule?.name).toBe('motion-alert');
    expect(entry!.rule?.fireId).toBe('fire-audit');
  });

  it('returns ok=false and writes error audit entry when path is unwritable', async () => {
    // Create a file where the parent directory should be — forces mkdirSync/appendFileSync to fail
    const fakeParent = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(fakeParent, 'this is a file, not a dir');
    const unwritable = path.join(fakeParent, 'events.jsonl');

    const result = await executeNotifyAction(fileAction(unwritable), {
      rule: baseRule,
      fireId: 'fire-err',
      eventPayload: {},
      deviceId: 'DEV_001',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();

    const entries = readAudit(auditLog);
    const entry = entries.find(e => e.kind === 'rule-notify');
    expect(entry).toBeDefined();
    expect(entry!.result).toBe('error');
  });

  it('rejects a relative path at runtime with a clear error', async () => {
    const result = await executeNotifyAction(fileAction('logs/relative.jsonl'), {
      rule: baseRule,
      fireId: 'fire-rel',
      eventPayload: {},
      deviceId: 'DEV_001',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/must be absolute/);

    const entries = readAudit(auditLog);
    const entry = entries.find(e => e.kind === 'rule-notify' && e.rule?.fireId === 'fire-rel');
    expect(entry).toBeDefined();
    expect(entry!.result).toBe('error');
  });
});

describe('executeNotifyAction — webhook channel', () => {
  let tmpDir: string;
  const originalArgv = process.argv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notify-wh-'));
    process.argv = ['node', 'cli', '--audit-log', '--audit-log-path', path.join(tmpDir, 'audit.log')];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.argv = originalArgv;
  });

  it('returns ok=false with connection refused error', async () => {
    const result = await executeNotifyAction(
      webhookAction('http://127.0.0.1:19991/hook'),
      { rule: baseRule, fireId: 'wh-1', eventPayload: {}, deviceId: 'DEV_001' },
    );

    expect(result.ok).toBe(false);
    expect(result.channel).toBe('webhook');
    expect(result.error).toBeDefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns ok=false with error when URL is invalid', async () => {
    const result = await executeNotifyAction(
      webhookAction('not-a-url'),
      { rule: baseRule, fireId: 'wh-2', eventPayload: {}, deviceId: 'DEV_001' },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
