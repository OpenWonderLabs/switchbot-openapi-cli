import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerHistoryCommand } from '../../src/commands/history.js';
import { runCli } from '../helpers/cli.js';
import { expectJsonEnvelopeContainingKeys } from '../helpers/contracts.js';

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
    it('exits 2 when --file swallows "--help"', async () => {
      const res = await runCli(registerHistoryCommand, [
        'history', 'show', '--file', '--help',
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/--file .* looks like another option/i);
    });

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
      const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')) as Record<string, unknown>;
      const data = expectJsonEnvelopeContainingKeys(out, ['file', 'total', 'entries']) as {
        total: number;
        entries: Array<{ deviceId: string }>;
      };
      expect(data.total).toBe(1);
      expect(data.entries[0].deviceId).toBe('A');
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

  describe('verify', () => {
    it('exits 0 with status warn when audit.log does not exist (fresh install)', async () => {
      const res = await runCli(registerHistoryCommand, [
        'history', 'verify', '--file', auditFile,
      ]);
      expect(res.exitCode).toBe(0);
      const out = res.stdout.join('\n');
      expect(out).toMatch(/fresh install/i);
      expect(out).toMatch(/warn/i);
    });

    it('exits 0 with status ok for an empty-but-existing file', async () => {
      fs.writeFileSync(auditFile, '');
      const res = await runCli(registerHistoryCommand, [
        'history', 'verify', '--file', auditFile,
      ]);
      expect(res.exitCode).toBe(0);
      const out = res.stdout.join('\n');
      expect(out).not.toMatch(/warn/i);
    });

    it('exits 1 with status fail when file has a malformed line', async () => {
      seed([
        { t: 't1', kind: 'command', deviceId: 'A', command: 'cmd', parameter: undefined, commandType: 'command', dryRun: false },
        'not valid json',
      ]);
      const res = await runCli(registerHistoryCommand, [
        'history', 'verify', '--file', auditFile,
      ]);
      expect(res.exitCode).toBe(1);
      const out = res.stdout.join('\n');
      expect(out).toMatch(/Malformed:/);
      expect(out).toMatch(/1/);
    });

    it('exits 0 with status warn and fileMissing=true when --json on missing file', async () => {
      const res = await runCli(registerHistoryCommand, [
        '--json', 'history', 'verify', '--file', auditFile,
      ]);
      expect(res.exitCode).toBe(0);
      const envelope = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      expect(envelope.data.status).toBe('warn');
      expect(envelope.data.fileMissing).toBe(true);
      expect(envelope.data.parsed).toBe(0);
      expect(envelope.data.malformed).toBe(0);
      expect(envelope.data.unversioned).toBe(0);
    });

    it('exits 1 with status fail when --json on file with malformed entries', async () => {
      // Write a file with a line that doesn't parse as JSON
      fs.writeFileSync(auditFile, 'not valid json\n');
      const res = await runCli(registerHistoryCommand, [
        '--json', 'history', 'verify', '--file', auditFile,
      ]);
      expect(res.exitCode).toBe(1);
      const envelope = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      expect(envelope.data.status).toBe('fail');
      expect(envelope.data.fileMissing).toBe(false);
      expect(envelope.data.malformed).toBeGreaterThan(0);
    });

    it('exits 0 with status ok when all entries are valid', async () => {
      seed([
        { auditVersion: 1, t: '2026-04-18T10:00:00.000Z', kind: 'command', deviceId: 'BOT1', command: 'turnOn', parameter: undefined, commandType: 'command', dryRun: false },
        { auditVersion: 1, t: '2026-04-18T10:00:05.000Z', kind: 'command', deviceId: 'BOT1', command: 'turnOff', parameter: undefined, commandType: 'command', dryRun: false },
      ]);
      const res = await runCli(registerHistoryCommand, [
        'history', 'verify', '--file', auditFile,
      ]);
      expect(res.exitCode).toBe(0);
      const out = res.stdout.join('\n');
      expect(out).toMatch(/Parsed lines:\s+2/);
    });
  });
});

describe('history range / stats (D3)', () => {
  let tmpHome: string;
  let historyDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-histcmd-'));
    historyDir = path.join(tmpHome, '.switchbot', 'device-history');
    fs.mkdirSync(historyDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  function seedJsonl(deviceId: string, records: Array<Record<string, unknown>>): void {
    const line = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(path.join(historyDir, `${deviceId}.jsonl`), line);
  }

  it('exits 2 when --since and --from are combined', async () => {
    const res = await runCli(registerHistoryCommand, [
      'history', 'range', 'DEV1', '--since', '1h', '--from', '2026-04-18T00:00:00Z',
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toMatch(/mutually exclusive/i);
  });

  it('exits 2 on bad --since format', async () => {
    const res = await runCli(registerHistoryCommand, [
      'history', 'range', 'DEV1', '--since', 'garbage',
    ]);
    expect(res.exitCode).toBe(2);
  });

  it('prints (no history records) when JSONL is missing', async () => {
    const res = await runCli(registerHistoryCommand, [
      'history', 'range', 'NOPE', '--since', '1h',
    ]);
    expect(res.stdout.join('\n')).toMatch(/no history records/);
  });

  it('emits JSON with {deviceId, count, records} when --json set', async () => {
    const now = Date.now();
    seedJsonl('DEV1', [
      { t: new Date(now - 30_000).toISOString(), topic: 'sb/DEV1', payload: { power: 'on' } },
      { t: new Date(now - 10_000).toISOString(), topic: 'sb/DEV1', payload: { power: 'off' } },
    ]);
    const res = await runCli(registerHistoryCommand, [
      '--json', 'history', 'range', 'DEV1', '--since', '5m',
    ]);
    const envelope = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')) as Record<string, unknown>;
    const data = expectJsonEnvelopeContainingKeys(envelope, ['deviceId', 'count', 'records']) as {
      deviceId: string;
      count: number;
      records: unknown[];
    };
    expect(data.deviceId).toBe('DEV1');
    expect(data.count).toBe(2);
    expect(data.records.length).toBe(2);
  });

  it('--field can be repeated to project payload subset', async () => {
    seedJsonl('DEV1', [
      { t: new Date().toISOString(), topic: 't', payload: { temp: 22, humidity: 50, battery: 90 } },
    ]);
    const res = await runCli(registerHistoryCommand, [
      '--json', 'history', 'range', 'DEV1', '--field', 'temp', '--field', 'humidity',
    ]);
    const env = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    expect(env.data.records[0].payload).toEqual({ temp: 22, humidity: 50 });
  });

  it('stats prints file/record counts in plain mode', async () => {
    seedJsonl('DEV1', [
      { t: '2026-04-01T00:00:00Z', topic: 't', payload: {} },
      { t: '2026-04-20T00:00:00Z', topic: 't', payload: {} },
    ]);
    const res = await runCli(registerHistoryCommand, ['history', 'stats', 'DEV1']);
    const out = res.stdout.join('\n');
    expect(out).toMatch(/Record count:\s+2/);
    expect(out).toMatch(/JSONL files:\s+1/);
    expect(out).toMatch(/2026-04-01/);
    expect(out).toMatch(/2026-04-20/);
  });

  it('stats --json emits structured payload', async () => {
    seedJsonl('DEV1', [
      { t: '2026-04-10T00:00:00Z', topic: 't', payload: {} },
    ]);
    const res = await runCli(registerHistoryCommand, ['--json', 'history', 'stats', 'DEV1']);
    const env = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')) as Record<string, unknown>;
    const data = expectJsonEnvelopeContainingKeys(env, ['deviceId', 'recordCount', 'jsonlFiles', 'oldest', 'newest']) as {
      deviceId: string;
      recordCount: number;
      oldest: string;
    };
    expect(data.deviceId).toBe('DEV1');
    expect(data.recordCount).toBe(1);
    expect(data.oldest).toBe('2026-04-10T00:00:00.000Z');
  });
});

describe('history aggregate (D7)', () => {
  let tmpHome: string;
  let historyDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-histcmd-agg-'));
    historyDir = path.join(tmpHome, '.switchbot', 'device-history');
    fs.mkdirSync(historyDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  function seedJsonl(deviceId: string, records: Array<Record<string, unknown>>): void {
    const line = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(path.join(historyDir, `${deviceId}.jsonl`), line);
  }

  it('emits the expected --json envelope for a single-bucket aggregation', async () => {
    seedJsonl('DEV1', [
      { t: '2026-04-19T10:00:00.000Z', topic: 'sb/DEV1', payload: { temperature: 20 } },
      { t: '2026-04-19T10:30:00.000Z', topic: 'sb/DEV1', payload: { temperature: 24 } },
    ]);
    const res = await runCli(registerHistoryCommand, [
      '--json', 'history', 'aggregate', 'DEV1',
      '--from', '2026-04-19T00:00:00.000Z',
      '--to', '2026-04-20T00:00:00.000Z',
      '--metric', 'temperature',
      '--agg', 'count,avg',
    ]);
    const parsed = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')) as Record<string, unknown>;
    const data = expectJsonEnvelopeContainingKeys(parsed, ['deviceId', 'from', 'to', 'metrics', 'aggs', 'buckets', 'partial', 'notes']) as {
      buckets: Array<{ metrics: { temperature: { count: number; avg: number } } }>;
    };
    expect(data.buckets[0].metrics.temperature.count).toBe(2);
    expect(data.buckets[0].metrics.temperature.avg).toBe(22);
  });

  it('exits with error when --metric is missing (requiredOption enforcement, bug #42)', async () => {
    const res = await runCli(registerHistoryCommand, [
      'history', 'aggregate', 'DEV1', '--since', '1h',
    ]);
    expect(res.exitCode).not.toBeNull();
    expect(res.exitCode).not.toBe(0);
    const errOut = res.stderr.join('\n');
    expect(errOut).toMatch(/--metric/);
  });
});
