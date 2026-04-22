/**
 * `switchbot policy {validate,new,migrate}` — CLI-plumbing tests.
 *
 * These drive the commander tree directly (no subprocess spawn) and
 * stub process.exit so we can assert exit codes. The API-level behavior
 * is already covered in tests/policy/validate.test.ts and load.test.ts;
 * here we verify the command wrappers translate results into the right
 * human text / JSON envelope and exit codes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { registerPolicyCommand } from '../../src/commands/policy.js';

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option('--json');
  registerPolicyCommand(program);
  return program;
}

interface RunResult {
  stdout: string[];
  stderr: string[];
  exitCode: number;
}

class ExitError extends Error {
  constructor(public code: number) {
    super(`__exit:${code}__`);
  }
}

function runCli(argv: string[]): RunResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);

  const program = makeProgram();
  let exitCode = 0;
  const prevArgv = process.argv;
  process.argv = ['node', 'switchbot', ...argv];
  try {
    program.parse(['node', 'switchbot', ...argv]);
  } catch (err) {
    if (err instanceof ExitError) exitCode = err.code;
    else throw err;
  } finally {
    process.argv = prevArgv;
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stdout, stderr, exitCode };
}

describe('switchbot policy (commander surface)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-policy-cmd-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('policy new', () => {
    it('writes the starter template to the given path (exit 0)', () => {
      const p = path.join(tmpDir, 'policy.yaml');
      const { stdout, exitCode } = runCli(['policy', 'new', p]);
      expect(exitCode).toBe(0);
      expect(fs.existsSync(p)).toBe(true);
      const contents = fs.readFileSync(p, 'utf-8');
      expect(contents).toMatch(/version: "0\.1"/);
      expect(stdout.join('\n')).toContain('wrote starter policy');
    });

    it('refuses to overwrite an existing file without --force (exit 5)', () => {
      const p = path.join(tmpDir, 'policy.yaml');
      fs.writeFileSync(p, 'original\n', 'utf-8');
      const { stderr, exitCode } = runCli(['policy', 'new', p]);
      expect(exitCode).toBe(5);
      expect(fs.readFileSync(p, 'utf-8')).toBe('original\n');
      expect(stderr.join('\n')).toContain('refusing to overwrite');
    });

    it('overwrites with --force', () => {
      const p = path.join(tmpDir, 'policy.yaml');
      fs.writeFileSync(p, 'original\n', 'utf-8');
      const { exitCode } = runCli(['policy', 'new', p, '--force']);
      expect(exitCode).toBe(0);
      expect(fs.readFileSync(p, 'utf-8')).toMatch(/version: "0\.1"/);
    });

    it('emits a structured --json envelope on success', () => {
      const p = path.join(tmpDir, 'policy.yaml');
      const { stdout, exitCode } = runCli(['--json', 'policy', 'new', p]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout[0]) as {
        schemaVersion: string;
        data: { policyPath: string; schemaVersion: string };
      };
      expect(parsed.schemaVersion).toBeDefined();
      expect(parsed.data.policyPath).toBe(p);
      expect(parsed.data.schemaVersion).toBe('0.1');
    });

    it('emits a --json error envelope when the file exists', () => {
      const p = path.join(tmpDir, 'policy.yaml');
      fs.writeFileSync(p, 'original\n', 'utf-8');
      const { stdout, exitCode } = runCli(['--json', 'policy', 'new', p]);
      expect(exitCode).toBe(5);
      const parsed = JSON.parse(stdout[0]) as { error: { code: number; kind: string } };
      expect(parsed.error.code).toBe(5);
      expect(parsed.error.kind).toBe('exists');
    });
  });

  describe('policy validate', () => {
    function seedValid(name = 'policy.yaml'): string {
      const p = path.join(tmpDir, name);
      fs.writeFileSync(p, 'version: "0.1"\n', 'utf-8');
      return p;
    }
    function seedInvalid(name = 'policy.yaml'): string {
      const p = path.join(tmpDir, name);
      // "0.9" is not a supported schema version — the validator short-circuits
      // with an `unsupported-version` error. Using a truly unsupported version
      // keeps this fixture invalid across future CLI releases that expand
      // SUPPORTED_POLICY_SCHEMA_VERSIONS.
      fs.writeFileSync(p, 'version: "0.9"\n', 'utf-8');
      return p;
    }

    it('exits 0 on a valid policy and prints the green tick line', () => {
      const p = seedValid();
      const { stdout, exitCode } = runCli(['policy', 'validate', p]);
      expect(exitCode).toBe(0);
      expect(stdout.join('\n')).toMatch(/is valid \(schema v0\.1\)/);
    });

    it('exits 1 on an invalid policy and prints error blocks', () => {
      const p = seedInvalid();
      const { stdout, exitCode } = runCli(['policy', 'validate', p]);
      expect(exitCode).toBe(1);
      const out = stdout.join('\n');
      expect(out).toContain('error');
      expect(out).toMatch(/1 error/);
    });

    it('exits 2 when the file does not exist with a hint', () => {
      const missing = path.join(tmpDir, 'nope.yaml');
      const { stderr, exitCode } = runCli(['policy', 'validate', missing]);
      expect(exitCode).toBe(2);
      expect(stderr.join('\n')).toContain('policy file not found');
    });

    it('exits 3 on YAML parse errors', () => {
      const p = path.join(tmpDir, 'bad.yaml');
      fs.writeFileSync(p, 'version: "0.1"\naliases: [unterminated\n', 'utf-8');
      const { stderr, exitCode } = runCli(['policy', 'validate', p]);
      expect(exitCode).toBe(3);
      expect(stderr.join('\n')).toContain('YAML parse error');
    });

    it('emits a full validation envelope in --json mode on success', () => {
      const p = seedValid();
      const { stdout, exitCode } = runCli(['--json', 'policy', 'validate', p]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout[0]) as {
        schemaVersion: string;
        data: { valid: boolean; errors: unknown[]; schemaVersion: string };
      };
      expect(parsed.data.valid).toBe(true);
      expect(parsed.data.errors).toEqual([]);
      expect(parsed.data.schemaVersion).toBe('0.1');
    });

    it('emits a validation envelope in --json mode on failure (still exit 1)', () => {
      const p = seedInvalid();
      const { stdout, exitCode } = runCli(['--json', 'policy', 'validate', p]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout[0]) as {
        data: { valid: boolean; errors: Array<{ keyword: string }> };
      };
      expect(parsed.data.valid).toBe(false);
      expect(parsed.data.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
    });

    it('emits a file-not-found envelope in --json mode (exit 2)', () => {
      const missing = path.join(tmpDir, 'nope.yaml');
      const { stdout, exitCode } = runCli(['--json', 'policy', 'validate', missing]);
      expect(exitCode).toBe(2);
      const parsed = JSON.parse(stdout[0]) as {
        error: { code: number; kind: string; hint: string };
      };
      expect(parsed.error.code).toBe(2);
      expect(parsed.error.kind).toBe('file-not-found');
      expect(parsed.error.hint).toContain('policy new');
    });
  });

  describe('policy migrate', () => {
    function seed(name: string, version: string | null): string {
      const p = path.join(tmpDir, name);
      const body = version === null ? 'aliases:\n' : `version: "${version}"\n`;
      fs.writeFileSync(p, body, 'utf-8');
      return p;
    }

    it('reports "already-current" on v0.2 with exit 0', () => {
      // LATEST supported is v0.2; seeding v0.2 hits the no-op path.
      const p = seed('policy.yaml', '0.2');
      const { stdout, exitCode } = runCli(['--json', 'policy', 'migrate', p]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout[0]) as { data: { status: string } };
      expect(parsed.data.status).toBe('already-current');
    });

    it('upgrades v0.1 → v0.2 in place and preserves comments + aliases', () => {
      const p = path.join(tmpDir, 'policy.yaml');
      const original = [
        '# My SwitchBot policy',
        'version: "0.1"',
        '',
        '# Friendly names map to deviceIds',
        'aliases:',
        '  "lamp": "01-202407090924-26354212"',
        '',
      ].join('\n');
      fs.writeFileSync(p, original, 'utf-8');

      const { stdout, exitCode } = runCli(['--json', 'policy', 'migrate', p]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout[0]) as {
        data: { status: string; from: string; to: string; bytesWritten: number };
      };
      expect(parsed.data.status).toBe('migrated');
      expect(parsed.data.from).toBe('0.1');
      expect(parsed.data.to).toBe('0.2');
      expect(parsed.data.bytesWritten).toBeGreaterThan(0);

      const after = fs.readFileSync(p, 'utf-8');
      expect(after).toContain('# My SwitchBot policy');
      expect(after).toContain('# Friendly names map to deviceIds');
      expect(after).toMatch(/version:\s*"0\.2"/);
      expect(after).toContain('01-202407090924-26354212');
    });

    it('--dry-run reports what would change without writing the file', () => {
      const p = seed('policy.yaml', '0.1');
      const before = fs.readFileSync(p, 'utf-8');
      const { stdout, exitCode } = runCli(['--json', 'policy', 'migrate', p, '--dry-run']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout[0]) as { data: { status: string; bytesWritten: number } };
      expect(parsed.data.status).toBe('dry-run');
      expect(parsed.data.bytesWritten).toBe(0);
      expect(fs.readFileSync(p, 'utf-8')).toBe(before);
    });

    it('reports "no-version-field" when version is absent (exit 0)', () => {
      const p = seed('policy.yaml', null);
      const { stdout, exitCode } = runCli(['--json', 'policy', 'migrate', p]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout[0]) as { data: { status: string } };
      expect(parsed.data.status).toBe('no-version-field');
    });

    it('emits an unsupported-version error envelope for newer schemas (exit 6)', () => {
      const p = seed('policy.yaml', '0.9');
      const { stdout, exitCode } = runCli(['--json', 'policy', 'migrate', p]);
      expect(exitCode).toBe(6);
      const parsed = JSON.parse(stdout[0]) as {
        error: { code: number; kind: string; hint: string };
      };
      expect(parsed.error.code).toBe(6);
      expect(parsed.error.kind).toBe('unsupported-version');
      expect(parsed.error.hint).toContain('downgrade');
    });

    it('exits 7 when the migrated file would fail v0.2 schema precheck', () => {
      // Seed a file that's valid v0.1 but breaks under v0.2 — an automation
      // block with a loose rule shape (v0.1 accepts it, v0.2 requires
      // {name, when, then}). The migration bumps version but leaves the
      // body alone, so the precheck surfaces the structural gap.
      const p = path.join(tmpDir, 'policy.yaml');
      fs.writeFileSync(
        p,
        [
          'version: "0.1"',
          'automation:',
          '  rules:',
          '    - foo: bar',
          '',
        ].join('\n'),
        'utf-8',
      );
      const before = fs.readFileSync(p, 'utf-8');
      const { stdout, exitCode } = runCli(['--json', 'policy', 'migrate', p]);
      expect(exitCode).toBe(7);
      const parsed = JSON.parse(stdout[0]) as {
        error: { code: number; kind: string; errors: Array<{ keyword: string }> };
      };
      expect(parsed.error.code).toBe(7);
      expect(parsed.error.kind).toBe('migration-precheck-failed');
      expect(parsed.error.errors.length).toBeGreaterThan(0);
      // File must stay untouched on precheck failure.
      expect(fs.readFileSync(p, 'utf-8')).toBe(before);
    });

    it('exits 2 when the file does not exist', () => {
      const missing = path.join(tmpDir, 'nope.yaml');
      const { exitCode } = runCli(['policy', 'migrate', missing]);
      expect(exitCode).toBe(2);
    });
  });
});
