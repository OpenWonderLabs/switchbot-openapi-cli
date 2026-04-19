import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isJsonMode,
  printJson,
  printTable,
  printKeyValue,
  handleError,
  buildErrorPayload,
  UsageError,
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

  it('prefers ApiError.hint over errorHint fallback in human-readable output', async () => {
    const { ApiError } = await import('../../src/api/client.js');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__exit');
    });

    // code 190 has an errorHint; error.hint on the instance should win
    expect(() => handleError(new ApiError('bad cmd', 190, { hint: 'use describe instead' }))).toThrow('__exit');
    const joined = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(joined).toContain('use describe instead');
    expect(joined).not.toContain('switchbot devices list');
  });

  describe('--json mode', () => {
    let originalArgv: string[];
    beforeEach(() => {
      originalArgv = process.argv;
      process.argv = ['node', 'cli', '--json', 'devices', 'status', 'X'];
    });
    afterEach(() => {
      process.argv = originalArgv;
    });

    it('outputs structured JSON error to stderr for ApiError', async () => {
      const { ApiError } = await import('../../src/api/client.js');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('__exit');
      });

      expect(() => handleError(new ApiError('bad device', 190))).toThrow('__exit');
      const raw = errSpy.mock.calls[0][0];
      const parsed = JSON.parse(raw);
      expect(parsed.error.code).toBe(190);
      expect(parsed.error.message).toBe('bad device');
      expect(parsed.error.hint).toMatch(/devices/);
    });

    it('marks 429 errors as retryable when ApiError.retryable is true', async () => {
      const { ApiError } = await import('../../src/api/client.js');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('__exit');
      });

      // Simulate what client.ts creates: retryable: true set explicitly.
      expect(() => handleError(new ApiError('rate limited', 429, { retryable: true, hint: 'check quota' }))).toThrow('__exit');
      const parsed = JSON.parse(errSpy.mock.calls[0][0]);
      expect(parsed.error.retryable).toBe(true);
      expect(parsed.error.hint).toBe('check quota');
    });

    it('prefers ApiError.hint over errorHint fallback when both exist', async () => {
      const { ApiError } = await import('../../src/api/client.js');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('__exit');
      });

      // code 429 has an errorHint, but the explicit hint should win.
      expect(() => handleError(new ApiError('over limit', 429, { retryable: true, hint: 'custom hint from client' }))).toThrow('__exit');
      const parsed = JSON.parse(errSpy.mock.calls[0][0]);
      expect(parsed.error.hint).toBe('custom hint from client');
    });

    it('does NOT set retryable when ApiError.retryable is false', async () => {
      const { ApiError } = await import('../../src/api/client.js');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('__exit');
      });

      expect(() => handleError(new ApiError('auth failed', 401, { retryable: false }))).toThrow('__exit');
      const parsed = JSON.parse(errSpy.mock.calls[0][0]);
      expect(parsed.error.retryable).toBeUndefined();
    });

    it('outputs structured JSON error for generic Error', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('__exit');
      });

      expect(() => handleError(new Error('kaboom'))).toThrow('__exit');
      const parsed = JSON.parse(errSpy.mock.calls[0][0]);
      expect(parsed.error.code).toBe(1);
      expect(parsed.error.message).toBe('kaboom');
    });
  });
});

describe('buildErrorPayload', () => {
  it('UsageError → code 2, kind usage', () => {
    const p = buildErrorPayload(new UsageError('bad flag'));
    expect(p).toEqual({ code: 2, kind: 'usage', message: 'bad flag', errorClass: 'usage', transient: false });
  });

  it('generic Error → code 1, kind runtime', () => {
    const p = buildErrorPayload(new Error('oops'));
    expect(p.code).toBe(1);
    expect(p.kind).toBe('runtime');
    expect(p.message).toBe('oops');
    expect(p.hint).toBeUndefined();
    expect(p.retryable).toBeUndefined();
    expect(p.transient).toBe(false);
  });

  it('unknown non-Error → code 1, kind runtime, fallback message', () => {
    const p = buildErrorPayload('just a string');
    expect(p.code).toBe(1);
    expect(p.kind).toBe('runtime');
    expect(p.message).toBe('An unknown error occurred');
    expect(p.transient).toBe(false);
  });

  it('ApiError → code from error, kind api, hint from error', async () => {
    const { ApiError } = await import('../../src/api/client.js');
    const p = buildErrorPayload(new ApiError('quota', 429, { retryable: true, hint: 'try later', transient: true }));
    expect(p.code).toBe(429);
    expect(p.kind).toBe('api');
    expect(p.message).toBe('quota');
    expect(p.hint).toBe('try later');
    expect(p.retryable).toBe(true);
    expect(p.transient).toBe(true);
  });

  it('ApiError with known code gets hint from errorHint table when no explicit hint', async () => {
    const { ApiError } = await import('../../src/api/client.js');
    const p = buildErrorPayload(new ApiError('not found', 152));
    expect(p.hint).toContain('deviceId');
    expect(p.transient).toBe(false);
  });
});
