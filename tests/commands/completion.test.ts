import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerCompletionCommand } from '../../src/commands/completion.js';
import { runCli } from '../helpers/cli.js';

describe('completion command', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let written: string[];

  beforeEach(() => {
    written = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('prints a bash completion script', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'bash']);
    expect(res.exitCode).toBeNull();
    const out = written.join('');
    expect(out).toContain('_switchbot_completion');
    expect(out).toContain('complete -F _switchbot_completion switchbot');
    expect(out).toContain('mcp quota catalog cache events doctor schema history plan capabilities');
    expect(out).toContain('--profile');
    expect(out).toContain('--audit-log-path');
  });

  it('prints a zsh completion script', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'zsh']);
    expect(res.exitCode).toBeNull();
    const out = written.join('');
    expect(out).toContain('compdef _switchbot switchbot');
    expect(out).toContain('_switchbot()');
  });

  it('prints a fish completion script', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'fish']);
    expect(res.exitCode).toBeNull();
    const out = written.join('');
    expect(out).toContain('complete -c switchbot');
    expect(out).toContain('__fish_use_subcommand');
    expect(out).toContain("-a 'events'");
    expect(out).toContain('-l profile');
    expect(out).toContain('-l audit-log-path');
  });

  it('prints a powershell completion script', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'powershell']);
    expect(res.exitCode).toBeNull();
    const out = written.join('');
    expect(out).toContain('Register-ArgumentCompleter');
    expect(out).toContain('switchbot');
    expect(out).toContain("'events'");
    expect(out).toContain("'--profile'");
    expect(out).toContain("'--audit-log-path'");
  });

  it('accepts "pwsh" as an alias for powershell', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'pwsh']);
    expect(res.exitCode).toBeNull();
    expect(written.join('')).toContain('Register-ArgumentCompleter');
  });

  it('exits 2 with guidance when the shell is unsupported', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'tcsh']);
    expect(res.exitCode).toBe(2);
    const err = res.stderr.join('\n');
    expect(err.toLowerCase()).toContain('unsupported shell');
    expect(err).toContain('bash, zsh, fish, powershell');
  });

  it('is case-insensitive on the shell argument', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'BASH']);
    expect(res.exitCode).toBeNull();
    expect(written.join('')).toContain('_switchbot_completion');
  });

  it('requires a shell argument', async () => {
    const res = await runCli(registerCompletionCommand, ['completion']);
    expect(res.stderr.join('\n').toLowerCase()).toContain('missing required');
  });
});
