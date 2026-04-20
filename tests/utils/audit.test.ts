import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeAudit, readAudit, verifyAudit, AUDIT_VERSION } from '../../src/utils/audit.js';

describe('audit log', () => {
  const originalArgv = process.argv;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbaudit-'));
    process.argv = ['node', 'cli'];
  });
  afterEach(() => {
    process.argv = originalArgv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writeAudit is a no-op when --audit-log flag is absent', () => {
    const file = path.join(tmp, 'audit.log');
    writeAudit({
      t: new Date().toISOString(),
      kind: 'command',
      deviceId: 'BOT1',
      command: 'turnOn',
      parameter: undefined,
      commandType: 'command',
      dryRun: false,
      result: 'ok',
    });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('writeAudit appends JSONL when --audit-log <path> is set', () => {
    const file = path.join(tmp, 'audit.log');
    process.argv = ['node', 'cli', '--audit-log', '--audit-log-path', file];
    writeAudit({
      t: '2026-04-18T10:00:00.000Z',
      kind: 'command',
      deviceId: 'BOT1',
      command: 'turnOn',
      parameter: undefined,
      commandType: 'command',
      dryRun: false,
      result: 'ok',
    });
    writeAudit({
      t: '2026-04-18T10:00:05.000Z',
      kind: 'command',
      deviceId: 'BOT1',
      command: 'turnOff',
      parameter: undefined,
      commandType: 'command',
      dryRun: true,
      result: 'ok',
    });
    const raw = fs.readFileSync(file, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).command).toBe('turnOn');
    expect(JSON.parse(lines[1]).command).toBe('turnOff');
  });

  it('writeAudit creates the parent directory if missing', () => {
    const file = path.join(tmp, 'nested', 'sub', 'audit.log');
    process.argv = ['node', 'cli', '--audit-log', '--audit-log-path', file];
    writeAudit({
      t: '2026-04-18T10:00:00.000Z',
      kind: 'command',
      deviceId: 'X',
      command: 'turnOn',
      parameter: undefined,
      commandType: 'command',
      dryRun: false,
      result: 'ok',
    });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('readAudit parses valid JSONL and skips malformed lines', () => {
    const file = path.join(tmp, 'audit.log');
    const content =
      JSON.stringify({ t: 't1', kind: 'command', deviceId: 'A', command: 'turnOn', parameter: undefined, commandType: 'command', dryRun: false, result: 'ok' }) +
      '\n{ malformed\n' +
      JSON.stringify({ t: 't2', kind: 'command', deviceId: 'B', command: 'turnOff', parameter: undefined, commandType: 'command', dryRun: false, result: 'ok' }) +
      '\n\n';
    fs.writeFileSync(file, content);
    const entries = readAudit(file);
    expect(entries).toHaveLength(2);
    expect(entries[0].deviceId).toBe('A');
    expect(entries[1].deviceId).toBe('B');
  });

  it('readAudit returns [] when the file does not exist', () => {
    expect(readAudit(path.join(tmp, 'nope.log'))).toEqual([]);
  });

  it('writeAudit stamps every record with the current auditVersion', () => {
    const file = path.join(tmp, 'audit.log');
    process.argv = ['node', 'cli', '--audit-log', '--audit-log-path', file];
    writeAudit({
      t: '2026-04-20T09:00:00.000Z',
      kind: 'command',
      deviceId: 'X',
      command: 'turnOn',
      parameter: undefined,
      commandType: 'command',
      dryRun: false,
      result: 'ok',
    });
    const line = fs.readFileSync(file, 'utf-8').trim();
    const parsed = JSON.parse(line);
    expect(parsed.auditVersion).toBe(AUDIT_VERSION);
    expect(parsed.deviceId).toBe('X');
  });

  it('verifyAudit reports parsed/malformed/version counts', () => {
    const file = path.join(tmp, 'audit.log');
    const ok1 = { auditVersion: 1, t: '2026-04-20T09:00:00.000Z', kind: 'command', deviceId: 'A', command: 'turnOn', parameter: 'default', commandType: 'command', dryRun: false, result: 'ok' };
    const legacy = { t: '2026-04-18T08:00:00.000Z', kind: 'command', deviceId: 'B', command: 'turnOff', parameter: 'default', commandType: 'command', dryRun: false, result: 'ok' };
    const content = [JSON.stringify(ok1), '{ not json', JSON.stringify(legacy), ''].join('\n');
    fs.writeFileSync(file, content);
    const report = verifyAudit(file);
    expect(report.parsedLines).toBe(2);
    expect(report.malformedLines).toBe(1);
    expect(report.unversionedEntries).toBe(1);
    expect(report.versionCounts['1']).toBe(1);
    expect(report.versionCounts['unversioned']).toBe(1);
    expect(report.earliest).toBe('2026-04-18T08:00:00.000Z');
    expect(report.latest).toBe('2026-04-20T09:00:00.000Z');
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0].reason).toContain('JSON parse');
  });

  it('verifyAudit returns a problem when file is missing', () => {
    const report = verifyAudit(path.join(tmp, 'missing.log'));
    expect(report.parsedLines).toBe(0);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0].reason).toContain('does not exist');
  });
});
