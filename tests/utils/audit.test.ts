import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeAudit, readAudit } from '../../src/utils/audit.js';

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
});
