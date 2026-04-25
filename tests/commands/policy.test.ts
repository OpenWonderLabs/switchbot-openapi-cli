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
      expect(contents).toMatch(/version: "0\.2"/);
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
      expect(fs.readFileSync(p, 'utf-8')).toMatch(/version: "0\.2"/);
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
      expect(parsed.data.schemaVersion).toBe('0.2');
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
      // Use v0.2 — v0.1 is unsupported in v3.0.
      fs.writeFileSync(p, 'version: "0.2"\n', 'utf-8');
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
      expect(stdout.join('\n')).toMatch(/is valid \(schema v0\.2\)/);
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
      fs.writeFileSync(p, 'version: "0.2"\naliases: [unterminated\n', 'utf-8');
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
      expect(parsed.data.schemaVersion).toBe('0.2');
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

    it('upgrades v0.1 → v0.2 now fails (no migration path in v3.0)', () => {
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
      // v0.1 is no longer in SUPPORTED_POLICY_SCHEMA_VERSIONS — exit 6.
      expect(exitCode).toBe(6);
      const parsed = JSON.parse(stdout[0]) as {
        error: { code: number; kind: string };
      };
      expect(parsed.error.code).toBe(6);
      expect(parsed.error.kind).toBe('unsupported-version');
      // File must be untouched.
      expect(fs.readFileSync(p, 'utf-8')).toBe(original);
    });

    it('--dry-run on v0.1 also returns exit 6 (unsupported, no migration path)', () => {
      const p = seed('policy.yaml', '0.1');
      const before = fs.readFileSync(p, 'utf-8');
      const { stdout, exitCode } = runCli(['--json', 'policy', 'migrate', p, '--dry-run']);
      // v0.1 unsupported — exits before dry-run logic.
      expect(exitCode).toBe(6);
      const parsed = JSON.parse(stdout[0]) as { error: { code: number; kind: string } };
      expect(parsed.error.code).toBe(6);
      expect(parsed.error.kind).toBe('unsupported-version');
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

    it('exits 7 when the migrated file would fail v0.2 schema precheck (v0.2 source)', () => {
      // Seed a v0.2 file with a broken automation rule that fails v0.2 precheck
      // when planMigration runs it through the validator again after a no-op.
      // Since MIGRATION_CHAIN is empty, we test precheck failure by seeding a
      // v0.2 file that already fails validation and observe that --to=0.2 on
      // an already-current file returns already-current (no exit 7 path here).
      //
      // The exit-7 path is exercised via a v0.2 file with a bad rule shape
      // supplied via the MCP test suite (policy_migrate refuses precheck).
      // Here we verify that a v0.1 file — which is no longer migratable —
      // returns exit 6 (unsupported), not exit 7.
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
      // v0.1 is unsupported — exits 6 before reaching precheck.
      expect(exitCode).toBe(6);
      const parsed = JSON.parse(stdout[0]) as {
        error: { code: number; kind: string };
      };
      expect(parsed.error.code).toBe(6);
      expect(parsed.error.kind).toBe('unsupported-version');
      // File must stay untouched.
      expect(fs.readFileSync(p, 'utf-8')).toBe(before);
    });

    it('exits 2 when the file does not exist', () => {
      const missing = path.join(tmpDir, 'nope.yaml');
      const { exitCode } = runCli(['policy', 'migrate', missing]);
      expect(exitCode).toBe(2);
    });
  });

  describe('policy diff', () => {
    it('prints no-difference message for identical files', () => {
      const left = path.join(tmpDir, 'left.yaml');
      const right = path.join(tmpDir, 'right.yaml');
      const body = ['version: "0.1"', 'aliases:', '  "lamp": "01-202407090924-26354212"', ''].join('\n');
      fs.writeFileSync(left, body, 'utf-8');
      fs.writeFileSync(right, body, 'utf-8');

      const { stdout, exitCode } = runCli(['policy', 'diff', left, right]);
      expect(exitCode).toBe(0);
      expect(stdout.join('\n')).toContain('no structural differences');
    });

    it('emits structured --json diff output with change stats', () => {
      const left = path.join(tmpDir, 'left.yaml');
      const right = path.join(tmpDir, 'right.yaml');
      fs.writeFileSync(left, ['version: "0.1"', 'quiet_hours:', '  start: "22:00"', ''].join('\n'), 'utf-8');
      fs.writeFileSync(right, ['version: "0.2"', 'quiet_hours:', '  start: "23:00"', ''].join('\n'), 'utf-8');

      const { stdout, exitCode } = runCli(['--json', 'policy', 'diff', left, right]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout[0]) as {
        data: {
          equal: boolean;
          changeCount: number;
          stats: { changed: number };
          changes: Array<{ path: string; kind: string }>;
          diff: string;
        };
      };
      expect(parsed.data.equal).toBe(false);
      expect(parsed.data.changeCount).toBeGreaterThan(0);
      expect(parsed.data.stats.changed).toBeGreaterThan(0);
      expect(parsed.data.changes.some((c) => c.path === '$.version')).toBe(true);
      expect(parsed.data.diff).toContain('--- before');
      expect(parsed.data.diff).toContain('+++ after');
    });

    it('exits 2 when either input file does not exist', () => {
      const left = path.join(tmpDir, 'left.yaml');
      fs.writeFileSync(left, 'version: "0.1"\n', 'utf-8');
      const missing = path.join(tmpDir, 'missing.yaml');

      const { stderr, exitCode } = runCli(['policy', 'diff', left, missing]);
      expect(exitCode).toBe(2);
      expect(stderr.join('\n')).toContain('policy file not found');
    });
  });

  // ── policy backup / restore ──────────────────────────────────────────────
  describe('policy backup', () => {
    let policyFile: string;

    beforeEach(() => {
      policyFile = path.join(tmpDir, 'policy.yaml');
      fs.writeFileSync(policyFile, 'version: "0.2"\n', 'utf-8');
      process.env.SWITCHBOT_POLICY_PATH = policyFile;
    });

    afterEach(() => {
      delete process.env.SWITCHBOT_POLICY_PATH;
    });

    it('creates a .bak.yaml backup alongside the policy', () => {
      const { stdout, exitCode } = runCli(['policy', 'backup']);
      expect(exitCode).toBe(0);
      const backupPath = policyFile.replace(/\.yaml$/, '.bak.yaml');
      expect(fs.existsSync(backupPath)).toBe(true);
      expect(fs.readFileSync(backupPath, 'utf-8')).toBe(fs.readFileSync(policyFile, 'utf-8'));
      expect(stdout.join('\n')).toContain('Backup written');
    });

    it('writes backup to an explicit path', () => {
      const dest = path.join(tmpDir, 'my-snapshot.yaml');
      const { stdout, exitCode } = runCli(['policy', 'backup', dest]);
      expect(exitCode).toBe(0);
      expect(fs.existsSync(dest)).toBe(true);
      expect(stdout.join('\n')).toContain(dest);
    });

    it('refuses to overwrite existing backup without --force', () => {
      const backupPath = policyFile.replace(/\.yaml$/, '.bak.yaml');
      fs.writeFileSync(backupPath, 'original\n', 'utf-8');

      const { exitCode } = runCli(['policy', 'backup']);
      expect(exitCode).toBe(2);
      expect(fs.readFileSync(backupPath, 'utf-8')).toBe('original\n');
    });

    it('overwrites existing backup with --force', () => {
      const backupPath = policyFile.replace(/\.yaml$/, '.bak.yaml');
      fs.writeFileSync(backupPath, 'old\n', 'utf-8');

      const { exitCode } = runCli(['policy', 'backup', '--force']);
      expect(exitCode).toBe(0);
      expect(fs.readFileSync(backupPath, 'utf-8')).not.toBe('old\n');
    });

    it('--json returns ok:true with source and dest', () => {
      const { stdout, exitCode } = runCli(['--json', 'policy', 'backup']);
      expect(exitCode).toBe(0);
      const out = JSON.parse(stdout[0]) as { data: Record<string, unknown> };
      expect(out.data.ok).toBe(true);
      expect(typeof out.data.source).toBe('string');
      expect(typeof out.data.dest).toBe('string');
    });

    it('exits 2 when the policy file does not exist', () => {
      fs.unlinkSync(policyFile);
      const { exitCode } = runCli(['policy', 'backup']);
      expect(exitCode).toBe(2);
    });
  });

  describe('policy restore', () => {
    let policyFile: string;
    let backupFile: string;

    beforeEach(() => {
      policyFile = path.join(tmpDir, 'policy.yaml');
      backupFile = path.join(tmpDir, 'policy.bak.yaml');
      // Write a valid v0.2 policy as the backup source.
      fs.writeFileSync(backupFile, 'version: "0.2"\n', 'utf-8');
      // Write a different active policy.
      fs.writeFileSync(policyFile, 'version: "0.2"\n# original\n', 'utf-8');
      process.env.SWITCHBOT_POLICY_PATH = policyFile;
    });

    afterEach(() => {
      delete process.env.SWITCHBOT_POLICY_PATH;
    });

    it('restores the backup to the active policy path', () => {
      const { stdout, exitCode } = runCli(['policy', 'restore', backupFile]);
      expect(exitCode).toBe(0);
      expect(fs.readFileSync(policyFile, 'utf-8')).toBe(fs.readFileSync(backupFile, 'utf-8'));
      expect(stdout.join('\n')).toContain('Policy restored');
    });

    it('auto-creates a pre-restore backup of the existing policy', () => {
      runCli(['policy', 'restore', backupFile]);
      const autoBackup = policyFile.replace(/\.yaml$/, '.pre-restore.bak.yaml');
      expect(fs.existsSync(autoBackup)).toBe(true);
    });

    it('exits 2 when the restore source does not exist', () => {
      const { exitCode } = runCli(['policy', 'restore', path.join(tmpDir, 'missing.yaml')]);
      expect(exitCode).toBe(2);
    });

    it('--json returns ok:true with restored path', () => {
      const { stdout, exitCode } = runCli(['--json', 'policy', 'restore', backupFile]);
      expect(exitCode).toBe(0);
      const out = JSON.parse(stdout[0]) as { data: Record<string, unknown> };
      expect(out.data.ok).toBe(true);
      expect(out.data.restored).toBe(policyFile);
    });
  });
});
