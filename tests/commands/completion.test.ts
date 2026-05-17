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

  it('bash completion includes all --format values', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'bash']);
    expect(res.exitCode).toBeNull();
    const out = written.join('');
    expect(out).toContain('local format_vals="table json jsonl tsv yaml id markdown"');
  });

  it('bash completion includes enum values for --backoff, --cache, and devices command --type', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'bash']);
    expect(res.exitCode).toBeNull();
    const out = written.join('');
    expect(out).toContain('linear exponential');
    expect(out).toContain('off auto 30s 5m 1h');
    expect(out).toContain('command customize');
  });

  it('prints a zsh completion script', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'zsh']);
    expect(res.exitCode).toBeNull();
    const out = written.join('');
    expect(out).toContain('compdef _switchbot switchbot');
    expect(out).toContain('_switchbot()');
  });

  it('zsh completion includes enum values for format, table style, backoff, and cache', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'zsh']);
    expect(res.exitCode).toBeNull();
    const out = written.join('');
    expect(out).toContain('--format[Output format]:type:(table json jsonl tsv yaml id markdown)');
    expect(out).toContain('--table-style[Table rendering style]:style:(unicode ascii simple markdown)');
    expect(out).toContain('--backoff[Retry backoff strategy]:strategy:(linear exponential)');
    expect(out).toContain('--cache[Cache mode]:mode:(off auto 30s 5m 1h)');
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

  it('fish completion includes enum values for format, table style, backoff, and cache', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'fish']);
    expect(res.exitCode).toBeNull();
    const out = written.join('');
    expect(out).toContain("-l format   -r -a 'table json jsonl tsv yaml id markdown'");
    expect(out).toContain("-l table-style -r -a 'unicode ascii simple markdown'");
    expect(out).toContain("-l backoff  -r -a 'linear exponential'");
    expect(out).toContain("-l cache    -r -a 'off auto 30s 5m 1h'");
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

  it('powershell completion includes enum value arrays for format, table style, backoff, and cache', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'powershell']);
    expect(res.exitCode).toBeNull();
    const out = written.join('');
    expect(out).toContain("$formatVals = 'table','json','jsonl','tsv','yaml','id','markdown'");
    expect(out).toContain("$tableStyleVals = 'unicode','ascii','simple','markdown'");
    expect(out).toContain("$backoffVals = 'linear','exponential'");
    expect(out).toContain("$cacheVals = 'off','auto','30s','5m','1h'");
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

  it('bash completion includes subcommand lists for policy, rules, auth, status-sync, and daemon', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'bash']);
    expect(res.exitCode).toBeNull();
    const out = written.join('');
    expect(out).toContain('policy)');
    expect(out).toContain('rules)');
    expect(out).toContain('auth)');
    expect(out).toContain('status-sync)');
    expect(out).toContain('daemon)');
    expect(out).toContain('policy_sub');
    expect(out).toContain('rules_sub');
    expect(out).toContain('auth_sub');
    expect(out).toContain('status_sync_sub');
    expect(out).toContain('daemon_sub');
  });

  it('zsh completion includes subcommand dispatchers for policy, rules, auth, status-sync, and daemon', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'zsh']);
    expect(res.exitCode).toBeNull();
    const out = written.join('');
    expect(out).toContain("policy) _describe 'policy'");
    expect(out).toContain("rules) _describe 'rules'");
    expect(out).toContain("auth) _describe 'auth'");
    expect(out).toContain("status-sync) _describe 'status-sync'");
    expect(out).toContain("daemon) _describe 'daemon'");
  });

  it('fish completion includes seen_subcommand_from entries for policy, rules, auth, status-sync, and daemon', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'fish']);
    expect(res.exitCode).toBeNull();
    const out = written.join('');
    expect(out).toContain('__fish_seen_subcommand_from policy');
    expect(out).toContain('__fish_seen_subcommand_from rules');
    expect(out).toContain('__fish_seen_subcommand_from auth');
    expect(out).toContain('__fish_seen_subcommand_from status-sync');
    expect(out).toContain('__fish_seen_subcommand_from daemon');
  });

  it('powershell completion includes switch cases for policy, rules, auth, status-sync, and daemon', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'powershell']);
    expect(res.exitCode).toBeNull();
    const out = written.join('');
    expect(out).toContain("'policy'");
    expect(out).toContain("'rules'");
    expect(out).toContain("'auth'");
    expect(out).toContain("'status-sync'");
    expect(out).toContain("'daemon'");
    expect(out).toContain('$policySub');
    expect(out).toContain('$rulesSub');
    expect(out).toContain('$authSub');
    expect(out).toContain('$statusSyncSub');
    expect(out).toContain('$daemonSub');
  });
});
