import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeAudit, readAudit, writeRefusalAudit } from '../../src/utils/audit.js';

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
    process.argv = ['node', 'cli', '--audit-log', file];
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
    process.argv = ['node', 'cli', '--audit-log', file];
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

  it('rotates to <file>.1 when the log exceeds 10MB', () => {
    const file = path.join(tmp, 'audit.log');
    process.argv = ['node', 'cli', '--audit-log', file];
    // Pre-fill 10MB+1 to force rotation on the next append.
    const filler = 'x'.repeat(10 * 1024 * 1024 + 1);
    fs.writeFileSync(file, filler);
    writeAudit({
      t: '2026-04-19T10:00:00.000Z',
      kind: 'command',
      deviceId: 'BOT',
      command: 'turnOn',
      parameter: undefined,
      commandType: 'command',
      dryRun: false,
      result: 'ok',
    });
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).command).toBe('turnOn');
  });

  it('writeRefusalAudit records a refused destructive attempt', () => {
    const file = path.join(tmp, 'audit.log');
    process.argv = ['node', 'cli', '--audit-log', file];
    writeRefusalAudit({
      deviceId: 'LOCK1',
      command: 'unlock',
      commandType: 'command',
      caller: 'cli',
      reason: 'destructive command "unlock" on Smart Lock requires --yes',
    });
    const entries = readAudit(file);
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('refused');
    expect(entries[0].destructive).toBe(true);
    expect(entries[0].confirmed).toBe(false);
    expect(entries[0].caller).toBe('cli');
    expect(entries[0].error).toContain('--yes');
  });
});
