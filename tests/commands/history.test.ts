import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerHistoryCommand } from '../../src/commands/history.js';
import { runCli } from '../helpers/cli.js';

const apiMock = vi.hoisted(() => {
  const instance = { get: vi.fn(), post: vi.fn() };
  return {
    createClient: vi.fn(() => instance),
    __instance: instance,
  };
});

vi.mock('../../src/api/client.js', () => ({
  createClient: apiMock.createClient,
  ApiError: class ApiError extends Error {
    constructor(message: string, public readonly code: number) {
      super(message);
      this.name = 'ApiError';
    }
  },
  DryRunSignal: class DryRunSignal extends Error {
    constructor(public readonly method: string, public readonly url: string) {
      super('dry-run');
      this.name = 'DryRunSignal';
    }
  },
}));

describe('history command', () => {
  let tmp: string;
  let auditFile: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbhist-'));
    auditFile = path.join(tmp, 'audit.log');
    apiMock.__instance.post.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function seed(entries: unknown[]): void {
    const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(auditFile, content);
  }

  describe('show', () => {
    it('prints (no entries) when the log does not exist', async () => {
      const res = await runCli(registerHistoryCommand, [
        'history', 'show', '--file', auditFile,
      ]);
      expect(res.stdout.join('\n')).toMatch(/no entries/);
    });

    it('prints each entry with an index, mark and command', async () => {
      seed([
        { t: '2026-04-18T10:00:00.000Z', kind: 'command', deviceId: 'BOT1', command: 'turnOn', parameter: undefined, commandType: 'command', dryRun: false, result: 'ok' },
        { t: '2026-04-18T10:00:05.000Z', kind: 'command', deviceId: 'BOT1', command: 'turnOff', parameter: undefined, commandType: 'command', dryRun: true, result: 'ok' },
      ]);
      const res = await runCli(registerHistoryCommand, [
        'history', 'show', '--file', auditFile,
      ]);
      const out = res.stdout.join('\n');
      expect(out).toMatch(/1\s+✓.*BOT1\s+turnOn/);
      expect(out).toMatch(/2\s+◦.*BOT1\s+turnOff/);
    });

    it('--limit truncates to the last N entries but preserves the 1-based index', async () => {
      seed([
        { t: 't1', kind: 'command', deviceId: 'A', command: 'turnOn', parameter: undefined, commandType: 'command', dryRun: false, result: 'ok' },
        { t: 't2', kind: 'command', deviceId: 'B', command: 'turnOn', parameter: undefined, commandType: 'command', dryRun: false, result: 'ok' },
        { t: 't3', kind: 'command', deviceId: 'C', command: 'turnOn', parameter: undefined, commandType: 'command', dryRun: false, result: 'ok' },
      ]);
      const res = await runCli(registerHistoryCommand, [
        'history', 'show', '--file', auditFile, '--limit', '2',
      ]);
      const out = res.stdout.join('\n');
      expect(out).not.toMatch(/ 1 /);
      expect(out).toMatch(/2 .*\bB\b/);
      expect(out).toMatch(/3 .*\bC\b/);
    });

    it('emits JSON with total + entries when --json is set', async () => {
      seed([
        { t: 't1', kind: 'command', deviceId: 'A', command: 'turnOn', parameter: undefined, commandType: 'command', dryRun: false, result: 'ok' },
      ]);
      const res = await runCli(registerHistoryCommand, [
        '--json', 'history', 'show', '--file', auditFile,
      ]);
      const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      expect(out.data.total).toBe(1);
      expect(out.data.entries[0].deviceId).toBe('A');
    });
  });

  describe('replay', () => {
    it('rejects an out-of-range index with exit 2', async () => {
      seed([
        { t: 't1', kind: 'command', deviceId: 'A', command: 'turnOn', parameter: undefined, commandType: 'command', dryRun: false, result: 'ok' },
      ]);
      const res = await runCli(registerHistoryCommand, [
        'history', 'replay', '5', '--file', auditFile,
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/Invalid index/);
    });

    it('re-runs the command at the requested 1-based index', async () => {
      seed([
        { t: 't1', kind: 'command', deviceId: 'BOT1', command: 'turnOn', parameter: undefined, commandType: 'command', dryRun: false, result: 'ok' },
        { t: 't2', kind: 'command', deviceId: 'BOT2', command: 'turnOff', parameter: undefined, commandType: 'command', dryRun: false, result: 'ok' },
      ]);
      apiMock.__instance.post.mockResolvedValueOnce({
        data: { statusCode: 100, body: {} },
      });

      const res = await runCli(registerHistoryCommand, [
        'history', 'replay', '2', '--file', auditFile,
      ]);
      expect(apiMock.__instance.post).toHaveBeenCalledTimes(1);
      const [url, body] = apiMock.__instance.post.mock.calls[0];
      expect(url).toBe('/v1.1/devices/BOT2/commands');
      expect((body as { command: string }).command).toBe('turnOff');
      expect(res.stdout.join('\n')).toMatch(/replayed turnOff on BOT2/);
    });
  });
});
