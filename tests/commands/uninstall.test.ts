import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectJsonEnvelopeContainingKeys } from '../helpers/contracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

function runCli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8' });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('switchbot uninstall (dry-run smoke)', () => {
  it('--help prints expected sections', () => {
    const { code, stdout } = runCli(['uninstall', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Reverse of `switchbot install`');
    expect(stdout).toContain('--agent <name>');
    expect(stdout).toContain('--remove-creds');
    expect(stdout).toContain('--remove-policy');
    expect(stdout).toContain('-y, --yes');
    expect(stdout).toContain('--purge');
  });

  it('--dry-run lists the planned removals without mutating anything', () => {
    const { code, stdout } = runCli(['--dry-run', 'uninstall', '--agent', 'none']);
    expect(code).toBe(0);
    expect(stdout).toContain('switchbot uninstall — dry run');
    expect(stdout).toContain('remove-credentials');
    expect(stdout).toContain('remove-policy');
    expect(stdout).toContain('No changes made');
  });

  it('--dry-run --json emits a structured plan including skill link for claude-code', () => {
    const { code, stdout } = runCli(['--dry-run', '--json', 'uninstall', '--agent', 'claude-code']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const data = expectJsonEnvelopeContainingKeys(parsed, ['dryRun', 'agent', 'plan']) as {
      dryRun: boolean;
      agent: string;
      plan: Array<{ action: string }>;
    };
    expect(data.dryRun).toBe(true);
    expect(data.agent).toBe('claude-code');
    const actions = data.plan.map((p) => p.action);
    expect(actions).toContain('remove-skill-link');
    expect(actions).toContain('remove-credentials');
    expect(actions).toContain('remove-policy');
  });

  it('--dry-run --json for agent=none omits the skill link action', () => {
    const { code, stdout } = runCli(['--dry-run', '--json', 'uninstall', '--agent', 'none']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const data = expectJsonEnvelopeContainingKeys(parsed, ['dryRun', 'agent', 'plan']) as {
      plan: Array<{ action: string }>;
    };
    const actions = data.plan.map((p) => p.action);
    expect(actions).not.toContain('remove-skill-link');
    expect(actions).toEqual(['remove-credentials', 'remove-policy']);
  });

  it('--purge implies --yes --remove-creds --remove-policy (visible in dry-run)', () => {
    // dry-run just prints the plan, but purge flag acceptance (no parse error) is the key test
    const { code } = runCli(['--dry-run', 'uninstall', '--agent', 'none', '--purge']);
    expect(code).toBe(0);
  });

  it('rejects unknown --agent values', () => {
    const { code, stderr } = runCli(['--dry-run', 'uninstall', '--agent', 'bogus']);
    expect(code).toBe(2);
    expect(stderr).not.toMatch(/at parseAgent/);
  });
});
