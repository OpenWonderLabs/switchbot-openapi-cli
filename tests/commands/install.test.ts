import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

function runCli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8' });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('switchbot install (dry-run smoke)', () => {
  it('--help prints expected sections', () => {
    const { code, stdout } = runCli(['install', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('One-command bootstrap');
    expect(stdout).toContain('--agent <name>');
    expect(stdout).toContain('--skill-path <dir>');
    expect(stdout).toContain('--token-file <path>');
    expect(stdout).toContain('Exit codes:');
  });

  it('--dry-run prints the step list without mutating anything', () => {
    const { code, stdout } = runCli(['install', '--dry-run', '--agent', 'none']);
    expect(code).toBe(0);
    expect(stdout).toContain('switchbot install — dry run');
    expect(stdout).toContain('prompt-credentials');
    expect(stdout).toContain('write-keychain');
    expect(stdout).toContain('scaffold-policy');
    expect(stdout).toContain('symlink-skill');
    expect(stdout).toContain('No changes made');
  });

  it('--dry-run --json emits a structured preview', () => {
    const { code, stdout } = runCli(['install', '--dry-run', '--json', '--agent', 'none']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.data.dryRun).toBe(true);
    expect(parsed.data.agent).toBe('none');
    expect(parsed.data.steps).toHaveLength(4);
    expect(parsed.data.steps.map((s: { name: string }) => s.name)).toEqual([
      'prompt-credentials',
      'write-keychain',
      'scaffold-policy',
      'symlink-skill',
    ]);
  });

  it('--dry-run --skip scaffold-policy,symlink-skill removes those from the list', () => {
    const { code, stdout } = runCli([
      'install',
      '--dry-run',
      '--json',
      '--agent',
      'none',
      '--skip',
      'scaffold-policy,symlink-skill',
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.data.steps.map((s: { name: string }) => s.name)).toEqual([
      'prompt-credentials',
      'write-keychain',
    ]);
  });

  it('rejects unknown --agent values', () => {
    const { code, stderr } = runCli(['install', '--dry-run', '--agent', 'bogus']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--agent must be one of/);
  });
});
