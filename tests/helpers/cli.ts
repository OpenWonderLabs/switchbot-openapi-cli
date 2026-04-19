import { Command } from 'commander';
import { vi } from 'vitest';

export interface RunResult {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}

/**
 * Build a fresh Commander program, register a single subcommand via the
 * provided registrar, and execute it with the given argv tail.
 *
 * Captures console.log / console.error output and any process.exit invocation
 * so tests can assert on CLI behavior without side effects on the real process.
 */
export async function runCli(
  register: (program: Command) => void,
  argv: string[]
): Promise<RunResult> {
  const program = new Command();
  program.exitOverride();
  program.option('--json', 'Output results in JSON format');
  program.option('--format <type>', 'Output format');
  program.option('--fields <csv>', 'Column filter');
  program.configureOutput({
    writeOut: (str) => stdout.push(stripTrailingNewline(str)),
    writeErr: (str) => stderr.push(stripTrailingNewline(str)),
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error('__exit__');
  }) as never);

  // isJsonMode() reads process.argv directly, so mirror it during the run.
  const originalArgv = process.argv;
  process.argv = ['node', 'test', ...argv];

  register(program);

  try {
    await program.parseAsync(['node', 'test', ...argv]);
  } catch (err) {
    const msg = (err as Error).message;
    const isInternalExit = msg === '__exit__';
    const errAsCommander = err as { code?: string; exitCode?: number; name?: string };
    const isCommanderExit =
      errAsCommander.code?.startsWith('commander.') === true ||
      errAsCommander.name === 'CommanderError' ||
      (typeof errAsCommander.exitCode === 'number' && typeof errAsCommander.code === 'string');
    if (!isInternalExit && !isCommanderExit) throw err;
    if (isCommanderExit && exitCode === null) {
      exitCode = errAsCommander.exitCode ?? 1;
    }
  } finally {
    process.argv = originalArgv;
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { stdout, stderr, exitCode };
}

function stripTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

/**
 * Parse a JSON envelope ({schemaVersion, ok, data, meta}) from CLI stdout and
 * return the inner `data` payload. Falls back to the raw parse for legacy
 * shapes, so tests can be updated incrementally. Also returns the raw parse
 * when the envelope is an error (ok:false) — callers should check `ok` first.
 */
export function parseEnvelope(raw: string): unknown {
  const parsed = JSON.parse(raw) as unknown;
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'schemaVersion' in parsed &&
    (parsed as { schemaVersion: unknown }).schemaVersion === '1' &&
    'ok' in parsed
  ) {
    const p = parsed as { ok: boolean; data?: unknown };
    if (p.ok) return p.data;
    return parsed;
  }
  return parsed;
}
