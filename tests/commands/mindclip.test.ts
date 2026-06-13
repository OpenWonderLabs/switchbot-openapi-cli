import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerMindclipCommand } from '../../src/commands/mindclip.js';

const mindclipMock = vi.hoisted(() => ({
  listRecordings: vi.fn().mockResolvedValue({}),
  getRecording: vi.fn().mockResolvedValue({}),
  getSummary: vi.fn().mockResolvedValue({}),
  listTodos: vi.fn().mockResolvedValue({}),
  getDailyRecall: vi.fn().mockResolvedValue({}),
  getWeeklySummary: vi.fn().mockResolvedValue({}),
  getUrgentTodos: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../src/lib/mindclip.js', () => mindclipMock);
vi.mock('../../src/utils/output.js', () => ({
  printJson: vi.fn(),
  isJsonMode: vi.fn(() => false),
  exitWithError: vi.fn((opts) => {
    throw new Error(typeof opts === 'string' ? opts : opts.message);
  }),
  handleError: vi.fn((error: unknown) => {
    throw error instanceof Error ? error : new Error(String(error));
  }),
}));

function buildProgram(): Command {
  const program = new Command().exitOverride();
  registerMindclipCommand(program);
  return program;
}

beforeEach(() => {
  Object.values(mindclipMock).forEach((fn) => fn.mockClear());
});

// ---------------------------------------------------------------------------
// recordings validation
// ---------------------------------------------------------------------------
describe('mindclip recordings validation', () => {
  it('rejects --page 0 (must be >= 1)', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'recordings', '--page', '0']),
    ).toThrow();
  });

  it('rejects --size 0', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'recordings', '--size', '0']),
    ).toThrow();
  });

  it('rejects --size 101', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'recordings', '--size', '101']),
    ).toThrow();
  });

  it('rejects --start with negative value', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'recordings', '--start', '-1']),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// todos validation
// ---------------------------------------------------------------------------
describe('mindclip todos validation', () => {
  it('rejects --completed 3 (only 0, 1, 2 allowed)', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'todos', '--completed', '3']),
    ).toThrow();
  });

  it('rejects --category 6 (max is 5)', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'todos', '--category', '6']),
    ).toThrow();
  });

  it('rejects --category negative', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'todos', '--category', '-1']),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// daily / weekly / urgent-todos validation
// ---------------------------------------------------------------------------
describe('mindclip date validation', () => {
  it('rejects --date in MM-DD-YYYY format', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'daily', '--date', '06-13-2026']),
    ).toThrow();
  });

  it('rejects --date with slashes', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'urgent-todos', '--date', '2026/06/13']),
    ).toThrow();
  });

  it('rejects --week without dash (2026W23)', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'weekly', '--week', '2026W23']),
    ).toThrow();
  });

  it('rejects --week W00', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'weekly', '--week', '2026-W00']),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// action handler smoke tests (valid args call the right lib function)
// ---------------------------------------------------------------------------
describe('mindclip action handlers', () => {
  it('recordings with no options calls listRecordings with empty params', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'recordings']);
    expect(mindclipMock.listRecordings).toHaveBeenCalledOnce();
    const params = mindclipMock.listRecordings.mock.calls[0][0];
    expect(Object.keys(params).length).toBe(0);
  });

  it('recording <id> calls getRecording with id', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'recording', 'abc123']);
    expect(mindclipMock.getRecording).toHaveBeenCalledWith('abc123', undefined);
  });

  it('recording <id> --language en calls getRecording with language', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'recording', 'abc123', '--language', 'en']);
    expect(mindclipMock.getRecording).toHaveBeenCalledWith('abc123', 'en');
  });

  it('summary <id> calls getSummary', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'summary', 's1']);
    expect(mindclipMock.getSummary).toHaveBeenCalledWith('s1');
  });

  it('todos --completed 1 calls listTodos with completedNum 1', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'todos', '--completed', '1']);
    const params = mindclipMock.listTodos.mock.calls[0][0];
    expect(params.completedNum).toBe(1);
  });

  it('daily --date 2026-06-10 calls getDailyRecall with that date', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'daily', '--date', '2026-06-10']);
    expect(mindclipMock.getDailyRecall).toHaveBeenCalledWith('2026-06-10');
  });

  it('daily with no date calls getDailyRecall with undefined', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'daily']);
    expect(mindclipMock.getDailyRecall).toHaveBeenCalledWith(undefined);
  });

  it('weekly --week 2026-W23 calls getWeeklySummary', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'weekly', '--week', '2026-W23']);
    expect(mindclipMock.getWeeklySummary).toHaveBeenCalledWith('2026-W23');
  });

  it('urgent-todos with no date calls getUrgentTodos with undefined (server defaults to yesterday)', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'urgent-todos']);
    expect(mindclipMock.getUrgentTodos).toHaveBeenCalledWith(undefined);
  });
});
