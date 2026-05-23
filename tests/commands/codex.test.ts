import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCli } from '../helpers/cli.js';
import { registerCodexCommand } from '../../src/commands/codex.js';

const spawnSyncRepairMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncRepairMock }));

const runDoctorChecksMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/commands/doctor.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, runDoctorChecks: runDoctorChecksMock };
});

const checkCodexCliMock = vi.hoisted(() => vi.fn());
const checkCodexPluginNpmMock = vi.hoisted(() => vi.fn());
const checkCodexPluginRegisteredMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/install/codex-checks.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    checkCodexCli: checkCodexCliMock,
    checkCodexPluginNpm: checkCodexPluginNpmMock,
    checkCodexPluginRegistered: checkCodexPluginRegisteredMock,
  };
});

function makeBaseChecks() {
  return [
    { name: 'node',        status: 'ok' as const, detail: 'Node 22.x' },
    { name: 'path',        status: 'ok' as const, detail: 'switchbot on PATH' },
    { name: 'credentials', status: 'ok' as const, detail: 'file: ~/.switchbot/config.json' },
    { name: 'mcp',         status: 'ok' as const, detail: '5 tools registered' },
  ];
}

function makeChecks(overrides: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: unknown }> = []) {
  const base = [
    { name: 'node',                    status: 'ok' as const, detail: 'ok' },
    { name: 'path',                    status: 'ok' as const, detail: 'ok' },
    { name: 'credentials',             status: 'ok' as const, detail: 'ok' },
    { name: 'mcp',                     status: 'ok' as const, detail: 'ok' },
    { name: 'codex-cli',               status: 'ok' as const, detail: 'ok' },
    { name: 'codex-plugin-npm',        status: 'ok' as const, detail: 'ok' },
    { name: 'codex-plugin-registered', status: 'ok' as const, detail: 'ok' },
  ];
  for (const override of overrides) {
    const idx = base.findIndex((c) => c.name === override.name);
    if (idx >= 0) base[idx] = override as typeof base[0];
  }
  return base;
}

beforeEach(() => {
  runDoctorChecksMock.mockReset();
  checkCodexCliMock.mockReset();
  checkCodexPluginNpmMock.mockReset();
  checkCodexPluginRegisteredMock.mockReset();
});

describe('switchbot codex doctor', () => {
  function setupAllOk() {
    runDoctorChecksMock.mockResolvedValue(makeBaseChecks());
    checkCodexCliMock.mockReturnValue({ name: 'codex-cli', status: 'ok', detail: 'found' });
    checkCodexPluginNpmMock.mockReturnValue({ name: 'codex-plugin-npm', status: 'ok', detail: 'v0.8.2' });
    checkCodexPluginRegisteredMock.mockReturnValue({ name: 'codex-plugin-registered', status: 'ok', detail: 'switchbot@pkg' });
  }

  it('exits 0 and prints 7 ok when all checks pass', async () => {
    setupAllOk();
    const { exitCode, stdout } = await runCli(registerCodexCommand, ['codex', 'doctor']);
    expect(exitCode).toBe(0);
    expect(stdout.join('\n')).toMatch(/7 ok/);
  });

  it('exits 1 when a codex-specific check fails', async () => {
    runDoctorChecksMock.mockResolvedValue(makeBaseChecks());
    checkCodexCliMock.mockReturnValue({ name: 'codex-cli', status: 'fail', detail: { message: 'not found on PATH' } });
    checkCodexPluginNpmMock.mockReturnValue({ name: 'codex-plugin-npm', status: 'ok', detail: 'v0.8.2' });
    checkCodexPluginRegisteredMock.mockReturnValue({ name: 'codex-plugin-registered', status: 'ok', detail: 'x' });
    const { exitCode } = await runCli(registerCodexCommand, ['codex', 'doctor']);
    expect(exitCode).toBe(1);
  });

  it('--json emits ok, overall, summary, checks keys', async () => {
    setupAllOk();
    const { stdout } = await runCli(registerCodexCommand, ['codex', 'doctor', '--json']);
    const parsed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    const data = (parsed.data ?? parsed) as Record<string, unknown>;
    expect(data).toHaveProperty('ok', true);
    expect(data).toHaveProperty('overall', 'ok');
    expect(data).toHaveProperty('summary');
    expect(Array.isArray(data.checks)).toBe(true);
  });

  it('--quiet hides passing checks', async () => {
    runDoctorChecksMock.mockResolvedValue(makeBaseChecks());
    checkCodexCliMock.mockReturnValue({ name: 'codex-cli', status: 'ok', detail: 'found' });
    checkCodexPluginNpmMock.mockReturnValue({ name: 'codex-plugin-npm', status: 'ok', detail: 'x' });
    checkCodexPluginRegisteredMock.mockReturnValue({
      name: 'codex-plugin-registered', status: 'warn', detail: { message: 'not registered' },
    });
    const { stdout } = await runCli(registerCodexCommand, ['codex', 'doctor', '--quiet']);
    const out = stdout.join('\n');
    expect(out).toContain('codex-plugin-registered');
    expect(out).not.toContain('node');
  });

  it('calls runDoctorChecks with exactly 4 base sections and codex checks directly', async () => {
    setupAllOk();
    await runCli(registerCodexCommand, ['codex', 'doctor']);
    const sections: string[] = runDoctorChecksMock.mock.calls[0][0] as string[];
    expect(sections).toHaveLength(4);
    expect(sections).toContain('node');
    expect(sections).toContain('path');
    expect(sections).toContain('credentials');
    expect(sections).toContain('mcp');
    expect(checkCodexCliMock).toHaveBeenCalledOnce();
    expect(checkCodexPluginNpmMock).toHaveBeenCalledOnce();
    expect(checkCodexPluginRegisteredMock).toHaveBeenCalledOnce();
  });
});

describe('switchbot codex repair', () => {
  beforeEach(() => {
    spawnSyncRepairMock.mockReset();
    runDoctorChecksMock.mockReset();
    checkCodexCliMock.mockReset();
    checkCodexPluginNpmMock.mockReset();
    checkCodexPluginRegisteredMock.mockReset();
  });

  it('--dry-run prints step list without running spawnSync', async () => {
    const { exitCode, stderr } = await runCli(
      registerCodexCommand,
      ['codex', 'repair', '--dry-run'],
    );
    expect(exitCode).toBe(0);
    const out = stderr.join('\n');
    expect(out).toContain('verify-cli');
    expect(out).toContain('re-auth');
    expect(out).toContain('remove-plugin');
    expect(out).toContain('register-plugin');
    expect(out).toContain('doctor-verify');
    expect(out).toContain('No changes made');
    expect(spawnSyncRepairMock).not.toHaveBeenCalled();
  });

  it('exits 2 when verify-cli finds a fail-level check', async () => {
    runDoctorChecksMock.mockResolvedValueOnce([
      { name: 'node', status: 'fail', detail: 'Node 16 < required v18' },
      { name: 'path', status: 'ok', detail: 'ok' },
    ]);
    const { exitCode } = await runCli(registerCodexCommand, ['codex', 'repair', '--skip', 're-auth,remove-plugin,register-plugin,doctor-verify']);
    expect(exitCode).toBe(2);
  });

  it('--skip re-auth,remove-plugin marks those steps as skipped in --json output', async () => {
    // verify-cli: node+path ok
    runDoctorChecksMock.mockResolvedValueOnce([
      { name: 'node', status: 'ok', detail: 'ok' },
      { name: 'path', status: 'ok', detail: 'ok' },
    ]);
    // register-plugin: npm root -g + marketplace add + plugin add
    spawnSyncRepairMock
      .mockReturnValueOnce({ status: 0, stdout: '/usr/local/lib/node_modules\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    // doctor-verify: all 7 checks ok (via runAllCodexDoctorChecks which calls runDoctorChecks + 3 codex checks)
    runDoctorChecksMock.mockResolvedValueOnce(makeBaseChecks()); // base 4 for doctor-verify
    checkCodexCliMock.mockReturnValue({ name: 'codex-cli', status: 'ok', detail: 'ok' });
    checkCodexPluginNpmMock.mockReturnValue({ name: 'codex-plugin-npm', status: 'ok', detail: 'ok' });
    checkCodexPluginRegisteredMock.mockReturnValue({ name: 'codex-plugin-registered', status: 'ok', detail: 'ok' });

    const { exitCode, stdout } = await runCli(
      registerCodexCommand,
      ['codex', 'repair', '--json', '--skip', 're-auth,remove-plugin'],
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.join('')) as { data?: { outcomes: Array<{ step: string; status: string }> }; outcomes?: Array<{ step: string; status: string }> };
    const outcomes = parsed.data?.outcomes ?? parsed.outcomes ?? [];
    const reAuth = outcomes.find((o) => o.step === 're-auth');
    const removePl = outcomes.find((o) => o.step === 'remove-plugin');
    expect(reAuth?.status).toBe('skipped');
    expect(removePl?.status).toBe('skipped');
  });

  it('exits 1 when register-plugin step fails', async () => {
    runDoctorChecksMock.mockResolvedValueOnce([
      { name: 'node', status: 'ok', detail: 'ok' },
      { name: 'path', status: 'ok', detail: 'ok' },
    ]);
    // npm root -g ok but marketplace add fails
    spawnSyncRepairMock
      .mockReturnValueOnce({ status: 0, stdout: '/usr/local/lib/node_modules\n', stderr: '' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'marketplace error' });
    // doctor-verify still runs after register-plugin fails — mock its runDoctorChecks call
    runDoctorChecksMock.mockResolvedValueOnce(makeBaseChecks());
    checkCodexCliMock.mockReturnValue({ name: 'codex-cli', status: 'ok', detail: 'ok' });
    checkCodexPluginNpmMock.mockReturnValue({ name: 'codex-plugin-npm', status: 'ok', detail: 'ok' });
    checkCodexPluginRegisteredMock.mockReturnValue({ name: 'codex-plugin-registered', status: 'ok', detail: 'ok' });

    const { exitCode } = await runCli(
      registerCodexCommand,
      ['codex', 'repair', '--skip', 're-auth,remove-plugin'],
    );
    // register-plugin failed → anyFailed=true → exit 1
    expect(exitCode).toBe(1);
  });
});
