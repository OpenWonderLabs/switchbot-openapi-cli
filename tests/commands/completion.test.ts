import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { registerCompletionCommand } from '../../src/commands/completion.js';
import { runCli } from '../helpers/cli.js';

// Generated script spelling is not a contract. Exercise output modes and
// executable completion behavior instead of asserting on source fragments.
describe('completion command', () => {
  let writeSpy: MockInstance<typeof process.stdout.write>;
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

  it('rejects JSON output before emitting shell source', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'bash', '--json']);
    expect(res.exitCode).toBe(2);
    expect(written).toEqual([]);
    expect(JSON.parse(res.stdout.join(''))).toMatchObject({
      error: { kind: 'usage', code: 2 },
    });
  });

  it('offers registered commands through executable Bash completion', async () => {
    const result = await runCli((program: Command) => {
      registerCompletionCommand(program);
      program.command('mindclip');
      program.command('codex');
    }, ['completion', 'bash']);
    expect(result.exitCode).toBeNull();
    const shell = spawnSync('bash', ['-c', `${written.join('')}
      COMP_WORDS=(switchbot mind)
      COMP_CWORD=1
      _switchbot_completion
      printf '%s\\n' "\${COMPREPLY[@]}"
    `], { encoding: 'utf8' });
    expect(shell.status).toBe(0);
    expect(shell.stdout.trim().split('\n')).toEqual(['mindclip']);
  });

  it('completes registered nested commands and aliases rather than a second command list', async () => {
    await runCli((program: Command) => {
      registerCompletionCommand(program);
      program.command('mindclip').command('transcript');
      const auth = program.command('auth');
      auth.command('login');
      auth.command('logout');
      auth.command('keychain').command('describe').alias('info');
    }, ['completion', 'bash']);
    const source = written.join('');
    const shell = spawnSync('bash', ['-c', `${source}
      COMP_WORDS=(switchbot mindclip tr); COMP_CWORD=2
      _switchbot_completion; printf 'mind:%s\\n' "\${COMPREPLY[@]}"
      COMP_WORDS=(switchbot auth lo); COMP_CWORD=2
      _switchbot_completion; printf 'auth:%s\\n' "\${COMPREPLY[@]}"
      COMP_WORDS=(switchbot auth keychain in); COMP_CWORD=3
      _switchbot_completion; printf 'nested:%s\\n' "\${COMPREPLY[@]}"
    `], { encoding: 'utf8' });
    expect(shell.status).toBe(0);
    expect(shell.stdout.trim().split('\n')).toEqual([
      'mind:transcript', 'auth:login', 'auth:logout', 'nested:info',
    ]);
  });

  it('exits 2 when the shell is unsupported', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'tcsh']);
    expect(res.exitCode).toBe(2);
  });

  it('requires a shell argument', async () => {
    const res = await runCli(registerCompletionCommand, ['completion']);
    expect(res.exitCode).toBe(2);
  });
});
