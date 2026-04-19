import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/flags.js', () => ({
  isDryRun: vi.fn(() => false),
  isVerbose: vi.fn(() => false),
  getTimeout: vi.fn(() => 30000),
  getConfigPath: vi.fn(() => undefined),
  getProfile: vi.fn(() => undefined),
  getAuditLog: vi.fn(() => null),
  getCacheMode: vi.fn(() => ({ listTtlMs: 0, statusTtlMs: 0 })),
  getFormat: vi.fn(() => undefined),
  getFields: vi.fn(() => undefined),
}));

import { parseFormat, filterFields, renderRows, resolveFormat, type OutputFormat } from '../../src/utils/format.js';

describe('parseFormat', () => {
  it('returns table when undefined', () => {
    expect(parseFormat(undefined)).toBe('table');
  });

  it('parses all valid formats', () => {
    expect(parseFormat('json')).toBe('json');
    expect(parseFormat('jsonl')).toBe('jsonl');
    expect(parseFormat('tsv')).toBe('tsv');
    expect(parseFormat('yaml')).toBe('yaml');
    expect(parseFormat('id')).toBe('id');
    expect(parseFormat('table')).toBe('table');
  });

  it('is case-insensitive', () => {
    expect(parseFormat('JSON')).toBe('json');
    expect(parseFormat('TSV')).toBe('tsv');
    expect(parseFormat('Yaml')).toBe('yaml');
  });

  it('exits 2 for unknown format', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      parseFormat('xml');
    } catch { /* expected */ }
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe('filterFields', () => {
  const headers = ['id', 'name', 'type', 'status'];
  const rows = [
    ['A1', 'Light', 'Bot', 'on'],
    ['A2', 'Lock', 'Smart Lock', 'locked'],
  ];

  it('returns all data when fields is undefined', () => {
    const result = filterFields(headers, rows, undefined);
    expect(result.headers).toEqual(headers);
    expect(result.rows).toEqual(rows);
  });

  it('returns all data when fields is empty', () => {
    const result = filterFields(headers, rows, []);
    expect(result.headers).toEqual(headers);
    expect(result.rows).toEqual(rows);
  });

  it('filters to requested columns', () => {
    const result = filterFields(headers, rows, ['id', 'type']);
    expect(result.headers).toEqual(['id', 'type']);
    expect(result.rows).toEqual([['A1', 'Bot'], ['A2', 'Smart Lock']]);
  });

  it('exits 2 on unknown field names', () => {
    expect(() => filterFields(headers, rows, ['id', 'nonexistent'])).toThrow('Unknown field(s): "nonexistent"');
  });

  it('preserves requested field order', () => {
    const result = filterFields(headers, rows, ['type', 'id']);
    expect(result.headers).toEqual(['type', 'id']);
    expect(result.rows).toEqual([['Bot', 'A1'], ['Smart Lock', 'A2']]);
  });
});

describe('renderRows', () => {
  const headers = ['deviceId', 'name', 'type'];
  const rows: unknown[][] = [
    ['DEV1', 'Light', 'Bot'],
    ['DEV2', 'Door', 'Smart Lock'],
  ];

  let logOutput: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logOutput = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logOutput.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('tsv: outputs tab-separated header + data rows', () => {
    renderRows(headers, rows, 'tsv');
    expect(logOutput[0]).toBe('deviceId\tname\ttype');
    expect(logOutput[1]).toBe('DEV1\tLight\tBot');
    expect(logOutput[2]).toBe('DEV2\tDoor\tSmart Lock');
  });

  it('tsv: respects fields filter', () => {
    renderRows(headers, rows, 'tsv', ['deviceId', 'type']);
    expect(logOutput[0]).toBe('deviceId\ttype');
    expect(logOutput[1]).toBe('DEV1\tBot');
  });

  it('jsonl: outputs one JSON object per line', () => {
    renderRows(headers, rows, 'jsonl');
    const parsed0 = JSON.parse(logOutput[0]);
    expect(parsed0).toEqual({ deviceId: 'DEV1', name: 'Light', type: 'Bot' });
    const parsed1 = JSON.parse(logOutput[1]);
    expect(parsed1).toEqual({ deviceId: 'DEV2', name: 'Door', type: 'Smart Lock' });
  });

  it('json: outputs a JSON array of objects', () => {
    renderRows(headers, rows, 'json');
    const parsed = JSON.parse(logOutput.join('\n'));
    expect(parsed).toEqual({
      schemaVersion: '1.1',
      data: [
        { deviceId: 'DEV1', name: 'Light', type: 'Bot' },
        { deviceId: 'DEV2', name: 'Door', type: 'Smart Lock' },
      ],
    });
  });

  it('yaml: outputs YAML documents with --- separators', () => {
    renderRows(headers, rows, 'yaml');
    const combined = logOutput.join('\n');
    expect(combined).toContain('---');
    expect(combined).toContain('deviceId: DEV1');
    expect(combined).toContain('name: Light');
    expect(combined).toContain('type: Smart Lock');
  });

  it('id: outputs the first column (deviceId) by default', () => {
    renderRows(headers, rows, 'id');
    expect(logOutput).toEqual(['DEV1', 'DEV2']);
  });

  it('id: picks sceneId column when present', () => {
    renderRows(['sceneId', 'sceneName'], [['S1', 'Bedtime'], ['S2', 'Morning']], 'id');
    expect(logOutput).toEqual(['S1', 'S2']);
  });

  it('id: exits 2 when no deviceId or sceneId column exists', () => {
    expect(() => renderRows(['power', 'battery'], [['on', 87]], 'id')).toThrow('--format=id requires');
  });

  it('handles null/undefined/boolean cells in tsv', () => {
    renderRows(['a', 'b', 'c'], [[null, undefined, true]], 'tsv');
    expect(logOutput[1]).toBe('\t\ttrue');
  });

  it('handles null cells in yaml', () => {
    renderRows(['a', 'b'], [[null, 'ok']], 'yaml');
    const combined = logOutput.join('\n');
    expect(combined).toContain('a: null');
    expect(combined).toContain('b: ok');
  });
});

import { afterEach } from 'vitest';
