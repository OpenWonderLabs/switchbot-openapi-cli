import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isJsonMode,
  printJson,
  printTable,
  printKeyValue,
  handleError,
} from '../../src/utils/output.js';

describe('isJsonMode', () => {
  let originalArgv: string[];
  beforeEach(() => {
    originalArgv = process.argv;
  });
  afterEach(() => {
    process.argv = originalArgv;
  });

  it('returns true when --json is present in process.argv', () => {
    process.argv = ['node', 'cli', 'devices', 'list', '--json'];
    expect(isJsonMode()).toBe(true);
  });

  it('returns false when --json is absent', () => {
    process.argv = ['node', 'cli', 'devices', 'list'];
    expect(isJsonMode()).toBe(false);
  });

  it('returns false when only a similar flag like --json-pretty is present (exact match)', () => {
    process.argv = ['node', 'cli', '--json-pretty'];
    expect(isJsonMode()).toBe(false);
  });
});

describe('printJson', () => {
  it('writes pretty-printed JSON with 2-space indent', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printJson({ a: 1, b: [2, 3] });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const out = logSpy.mock.calls[0][0];
    expect(out).toBe(JSON.stringify({ a: 1, b: [2, 3] }, null, 2));
    expect(out).toContain('\n  ');
  });

  it('handles null and primitives', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printJson(null);
    printJson(42);
    printJson('hi');
    expect(logSpy.mock.calls.map((c) => c[0])).toEqual(['null', '42', '"hi"']);
  });
});

describe('printTable', () => {
  it('renders a table with headers and string rows without throwing', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printTable(['a', 'b'], [['x', 'y']]);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const out = logSpy.mock.calls[0][0];
    expect(out).toContain('x');
    expect(out).toContain('y');
  });

  it('renders null and undefined cells as em-dash', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printTable(['a', 'b'], [[null, undefined]]);
    expect(logSpy.mock.calls[0][0]).toContain('—');
  });

  it('renders booleans as check/cross marks', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printTable(['flag1', 'flag2'], [[true, false]]);
    const out = logSpy.mock.calls[0][0];
    expect(out).toContain('✓');
    expect(out).toContain('✗');
  });

  it('stringifies number cells', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printTable(['n'], [[42]]);
    expect(logSpy.mock.calls[0][0]).toContain('42');
  });

  it('renders without rows (header-only) without throwing', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => printTable(['a', 'b'], [])).not.toThrow();
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});

describe('printKeyValue', () => {
  it('renders each entry as a key-value row', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printKeyValue({ foo: 'bar', n: 1 });
    const out = logSpy.mock.calls[0][0];
    expect(out).toContain('foo');
    expect(out).toContain('bar');
    expect(out).toContain('n');
    expect(out).toContain('1');
  });

  it('skips null and undefined values', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printKeyValue({ keep: 'yes', gone: null, alsoGone: undefined });
    const out = logSpy.mock.calls[0][0];
    expect(out).toContain('keep');
    expect(out).not.toContain('gone');
    expect(out).not.toContain('alsoGone');
  });

  it('JSON-stringifies object values', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printKeyValue({ obj: { x: 1 } });
    expect(logSpy.mock.calls[0][0]).toContain('{"x":1}');
  });

  it('stringifies boolean values', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printKeyValue({ ok: true, bad: false });
    const out = logSpy.mock.calls[0][0];
    expect(out).toContain('true');
    expect(out).toContain('false');
  });
});

describe('handleError', () => {
  it('prints "Error: <message>" and exits with code 1 for Error instances', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__exit');
    });

    expect(() => handleError(new Error('boom'))).toThrow('__exit');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Error: boom'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints a generic message and exits for non-Error values', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__exit');
    });

    expect(() => handleError('a string')).toThrow('__exit');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('An unknown error occurred'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('handles undefined error values', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__exit');
    });

    expect(() => handleError(undefined)).toThrow('__exit');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('An unknown error occurred'));
  });

  it('recognizes DryRunSignal and exits cleanly with code 0', async () => {
    const { DryRunSignal } = await import('../../src/api/client.js');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__exit');
    });

    expect(() => handleError(new DryRunSignal('POST', 'https://x/y'))).toThrow('__exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('prefixes ApiError output with the error code', async () => {
    const { ApiError } = await import('../../src/api/client.js');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__exit');
    });

    expect(() => handleError(new ApiError('boom', 190))).toThrow('__exit');
    const joined = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(joined).toContain('Error (code 190): boom');
  });

  it('prints a hint for known ApiError codes (e.g. 190)', async () => {
    const { ApiError } = await import('../../src/api/client.js');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__exit');
    });

    expect(() => handleError(new ApiError('x', 190))).toThrow('__exit');
    const joined = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(joined).toContain('Hint:');
    expect(joined).toMatch(/devices list|devices describe/);
  });

  it('does not print a hint for unknown/unmapped codes', async () => {
    const { ApiError } = await import('../../src/api/client.js');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__exit');
    });

    expect(() => handleError(new ApiError('x', 999))).toThrow('__exit');
    const joined = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(joined).toContain('Error (code 999): x');
    expect(joined).not.toContain('Hint:');
  });
});
