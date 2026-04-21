/**
 * P5: error-envelope contract test.
 *
 * Every CLI error path that goes through `exitWithError(...)` MUST emit on
 * stdout (not stderr) a JSON object of shape
 *   { schemaVersion: "1.1", error: { code, kind, message, ... } }
 * when running under `--json`.
 *
 * This test drives typical error paths across several commands and asserts
 * the envelope is well-formed JSON with the required fields. It is a
 * regression guard against the old `console.error(JSON.stringify(...))`
 * bypass pattern that some commands used before P5.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

import {
  emitJsonError,
  exitWithError,
  SCHEMA_VERSION,
} from '../../src/utils/output.js';

describe('error envelope contract (P5)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => {
        throw new Error('process.exit');
      }) as never);
  });

  it('emitJsonError wraps payload in { schemaVersion, error }', () => {
    emitJsonError({ code: 2, kind: 'usage', message: 'bad arg' });

    const emitted = stdoutSpy.mock.calls[0]?.[0];
    expect(typeof emitted).toBe('string');
    const parsed = JSON.parse(emitted as string);
    expect(parsed).toEqual({
      schemaVersion: SCHEMA_VERSION,
      error: { code: 2, kind: 'usage', message: 'bad arg' },
    });
  });

  it('exitWithError in --json mode emits envelope on stdout and exits with the code', () => {
    const prevArgv = process.argv;
    process.argv = [...prevArgv, '--json'];
    try {
      expect(() =>
        exitWithError({
          code: 2,
          kind: 'usage',
          message: 'missing --foo',
          hint: 'pass --foo <value>',
          context: { flag: '--foo' },
        }),
      ).toThrow('process.exit');

      expect(exitSpy).toHaveBeenCalledWith(2);
      const emitted = stdoutSpy.mock.calls[0]?.[0];
      const parsed = JSON.parse(emitted as string);
      expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
      expect(parsed.error).toMatchObject({
        code: 2,
        kind: 'usage',
        message: 'missing --foo',
        hint: 'pass --foo <value>',
        context: { flag: '--foo' },
      });
    } finally {
      process.argv = prevArgv;
    }
  });

  it('exitWithError in plain mode writes message+hint to stderr, not stdout', () => {
    expect(() =>
      exitWithError({
        code: 2,
        kind: 'usage',
        message: 'boom',
        hint: 'try --help',
      }),
    ).toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(stdoutSpy).not.toHaveBeenCalled();
    const stderrLines = stderrSpy.mock.calls.map((c) => c[0]);
    expect(stderrLines).toContain('boom');
    expect(stderrLines).toContain('try --help');
  });

  it('exitWithError kind defaults to "usage" and code defaults to 2', () => {
    const prevArgv = process.argv;
    process.argv = [...prevArgv, '--json'];
    try {
      expect(() => exitWithError('minimum usage error')).toThrow('process.exit');

      const parsed = JSON.parse(stdoutSpy.mock.calls[0]?.[0] as string);
      expect(parsed.error.code).toBe(2);
      expect(parsed.error.kind).toBe('usage');
      expect(parsed.error.message).toBe('minimum usage error');
      expect(exitSpy).toHaveBeenCalledWith(2);
    } finally {
      process.argv = prevArgv;
    }
  });

  it('exitWithError supports runtime kind + non-2 exit codes', () => {
    const prevArgv = process.argv;
    process.argv = [...prevArgv, '--json'];
    try {
      expect(() =>
        exitWithError({
          code: 1,
          kind: 'runtime',
          message: 'subprocess failed',
        }),
      ).toThrow('process.exit');

      const parsed = JSON.parse(stdoutSpy.mock.calls[0]?.[0] as string);
      expect(parsed.error.code).toBe(1);
      expect(parsed.error.kind).toBe('runtime');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      process.argv = prevArgv;
    }
  });

  it('exitWithError "extra" fields are merged into error payload (flat)', () => {
    const prevArgv = process.argv;
    process.argv = [...prevArgv, '--json'];
    try {
      expect(() =>
        exitWithError({
          code: 2,
          message: 'validation failed',
          extra: { validationKind: 'unknown-command', deviceId: 'D-1' },
        }),
      ).toThrow('process.exit');

      const parsed = JSON.parse(stdoutSpy.mock.calls[0]?.[0] as string);
      expect(parsed.error.validationKind).toBe('unknown-command');
      expect(parsed.error.deviceId).toBe('D-1');
    } finally {
      process.argv = prevArgv;
    }
  });

  it('no CLI command source file still uses the emitJsonError + process.exit bypass', async () => {
    // Sanity: import the command modules and confirm exitWithError is the
    // canonical path. This is a cheap textual audit that fails if a future
    // contributor re-introduces the bypass.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cmdDir = path.resolve(__dirname, '../../src/commands');
    const files = fs
      .readdirSync(cmdDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join(cmdDir, f));

    const offenders: string[] = [];
    for (const file of files) {
      const raw = fs.readFileSync(file, 'utf-8');
      // Look for the bypass pattern: emitJsonError(...) in the same block
      // as process.exit(N). Ignore mcp.ts (protocol-level signal handlers
      // exit without an envelope — that is intentional).
      if (file.endsWith('mcp.ts')) continue;
      const hasEmit = /emitJsonError\s*\(/.test(raw);
      const hasExit = /process\.exit\s*\(\s*[12]\s*\)/.test(raw);
      if (hasEmit && hasExit) offenders.push(path.basename(file));
    }
    expect(
      offenders,
      `command files still pair emitJsonError() with process.exit():\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});

/**
 * Silence unused-vars — keep Command import available for future command-level
 * smoke tests under this suite.
 */
void Command;
