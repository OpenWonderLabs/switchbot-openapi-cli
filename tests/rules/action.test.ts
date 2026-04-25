import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  executeRuleAction,
  parseRuleCommand,
  resolveActionDevice,
  extractDeviceIdFromAction,
} from '../../src/rules/action.js';
import type { Rule } from '../../src/rules/types.js';
import { readAudit } from '../../src/utils/audit.js';

const baseRule: Rule = {
  name: 'test rule',
  when: { source: 'mqtt', event: 'motion.detected' },
  then: [{ command: 'devices command <id> turnOn' }],
};

describe('parseRuleCommand', () => {
  it('parses the canonical shape', () => {
    expect(parseRuleCommand('devices command FAKE-ID turnOn')).toEqual({
      deviceIdSlot: 'FAKE-ID',
      verb: 'turnOn',
      parameterTokens: [],
    });
  });
  it('captures multi-token parameters', () => {
    expect(parseRuleCommand('devices command <id> setMode cool 72')).toEqual({
      deviceIdSlot: '<id>',
      verb: 'setMode',
      parameterTokens: ['cool', '72'],
    });
  });
  it('returns null for shapes we do not understand', () => {
    expect(parseRuleCommand('scenes run abc')).toBeNull();
    expect(parseRuleCommand('')).toBeNull();
  });
});

describe('resolveActionDevice', () => {
  it('prefers explicit device field over command slot', () => {
    expect(resolveActionDevice('bedroom light', 'FAKE-ID', { 'bedroom light': 'RESOLVED' })).toBe(
      'RESOLVED',
    );
  });
  it('falls back to the command slot when the action has no device field', () => {
    expect(resolveActionDevice(undefined, 'FAKE-ID', {})).toBe('FAKE-ID');
  });
  it('returns null when the command slot is the placeholder and no device is set', () => {
    expect(resolveActionDevice(undefined, '<id>', {})).toBeNull();
  });
  it('raw string that is not an alias passes through unchanged', () => {
    expect(resolveActionDevice('LITERAL-ID', null, { something: 'else' })).toBe('LITERAL-ID');
  });
});

describe('executeRuleAction', () => {
  const originalArgv = process.argv;
  let tmp: string;
  let auditFile: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrules-'));
    auditFile = path.join(tmp, 'audit.log');
    process.argv = ['node', 'cli', '--audit-log', '--audit-log-path', auditFile];
  });
  afterEach(() => {
    process.argv = originalArgv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses a destructive command and records it in audit', async () => {
    const action = { command: 'devices command LOCK-1 unlock' };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action] },
      fireId: 'fire-1',
      aliases: {},
      skipApiCall: true,
    });
    expect(result.blocked).toBe(true);
    expect(result.error).toContain('destructive-verb:unlock');
    const entries = readAudit(auditFile);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('rule-fire');
    expect(entries[0].result).toBe('error');
    expect(entries[0].rule?.name).toBe('test rule');
  });

  it('dry-run records rule-fire-dry and skips the API', async () => {
    const action = { command: 'devices command AA-BB turnOn' };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action], dry_run: true },
      fireId: 'fire-2',
      aliases: {},
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    const entries = readAudit(auditFile);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('rule-fire-dry');
    expect(entries[0].deviceId).toBe('AA-BB');
    expect(entries[0].rule?.fireId).toBe('fire-2');
  });

  it('resolves aliases before calling executeCommand', async () => {
    const action = { command: 'devices command <id> turnOn', device: 'bedroom light' };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action] },
      fireId: 'fire-3',
      aliases: { 'bedroom light': 'AA-BB-CC' },
      skipApiCall: true,
    });
    expect(result.ok).toBe(true);
    expect(result.deviceId).toBe('AA-BB-CC');
    const entries = readAudit(auditFile);
    expect(entries[0].deviceId).toBe('AA-BB-CC');
    expect(entries[0].rule?.reason).toBe('api-skipped');
  });

  it('missing device (command uses <id> and action has no device field) errors cleanly', async () => {
    const action = { command: 'devices command <id> turnOn' };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action] },
      fireId: 'fire-4',
      aliases: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('missing-device');
  });

  it('unparseable command is audited and reported', async () => {
    const action = { command: 'scenes run welcome-home' };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action] },
      fireId: 'fire-5',
      aliases: {},
    });
    expect(result.blocked).toBe(true);
    const entries = readAudit(auditFile);
    expect(entries[0].error).toBe('unparseable-command');
  });

  it('globalDryRun forces dry-run even when rule.dry_run is false', async () => {
    const action = { command: 'devices command AA-BB turnOff' };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action], dry_run: false },
      fireId: 'fire-6',
      aliases: {},
      globalDryRun: true,
    });
    expect(result.dryRun).toBe(true);
    const entries = readAudit(auditFile);
    expect(entries[0].kind).toBe('rule-fire-dry');
  });
});

describe('extractDeviceIdFromAction', () => {
  it('returns action.device when present, ignoring the command string', () => {
    expect(extractDeviceIdFromAction({ command: 'devices command OTHER turnOn', device: 'EXPLICIT' }))
      .toBe('EXPLICIT');
  });

  it('extracts deviceId from command string when device field is absent', () => {
    expect(extractDeviceIdFromAction({ command: 'devices command DEVICE123 turnOn' }))
      .toBe('DEVICE123');
  });

  it('returns the <id> placeholder literal when command uses a placeholder', () => {
    expect(extractDeviceIdFromAction({ command: 'devices command <id> turnOn' }))
      .toBe('<id>');
  });

  it('returns null when command does not match the devices command pattern', () => {
    expect(extractDeviceIdFromAction({ command: 'scenes run welcome' })).toBeNull();
    expect(extractDeviceIdFromAction({ command: '' })).toBeNull();
  });
});
