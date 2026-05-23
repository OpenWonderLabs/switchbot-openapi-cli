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
const registerCodexPluginMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/install/codex-checks.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    checkCodexCli: checkCodexCliMock,
    checkCodexPluginNpm: checkCodexPluginNpmMock,
    checkCodexPluginRegistered: checkCodexPluginRegisteredMock,
    registerCodexPlugin: registerCodexPluginMock,
  };
});

const tryLoadConfigMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, tryLoadConfig: tryLoadConfigMock };
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
  registerCodexPluginMock.mockReset();
  tryLoadConfigMock.mockReset();
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
    registerCodexPluginMock.mockReset();
    tryLoadConfigMock.mockReset();
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
    // C4.3: register-plugin now mocks at the registerCodexPlugin boundary, not spawnSync.
    registerCodexPluginMock.mockReturnValueOnce({
      ok: true,
      pluginId: 'switchbot@codex-plugin',
      packageRoot: '/usr/local/lib/node_modules/@switchbot/codex-plugin',
    });
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
    // C4.3: confirm we hit the shared helper (and only once for register-plugin)
    expect(registerCodexPluginMock).toHaveBeenCalledOnce();
  });

  it('exits 1 when register-plugin step fails', async () => {
    runDoctorChecksMock.mockResolvedValueOnce([
      { name: 'node', status: 'ok', detail: 'ok' },
      { name: 'path', status: 'ok', detail: 'ok' },
    ]);
    // C4.3: register-plugin failure surfaces via the shared helper's normalized error.
    registerCodexPluginMock.mockReturnValueOnce({
      ok: false,
      pluginId: 'switchbot@codex-plugin',
      packageRoot: '/usr/local/lib/node_modules/@switchbot/codex-plugin',
      error: 'exit 1: marketplace error',
      exitCode: 1,
      stderr: 'marketplace error',
    });
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

  // A1: re-auth must spawn the running switchbot binary (process.execPath + cliPath)
  // and forward both --profile and --config so credentials land in the correct scope.
  it('re-auth spawns process.execPath with --config forwarded when credentials are missing', async () => {
    // verify-cli passes
    runDoctorChecksMock.mockResolvedValueOnce([
      { name: 'node', status: 'ok', detail: 'ok' },
      { name: 'path', status: 'ok', detail: 'ok' },
    ]);
    // credentials missing
    tryLoadConfigMock.mockReturnValue(null);
    // re-auth spawn returns 0 → ok
    spawnSyncRepairMock.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    // remove-plugin is skipped via --skip; register-plugin is not skippable → mock helper
    registerCodexPluginMock.mockReturnValueOnce({
      ok: true, pluginId: 'switchbot@codex-plugin', packageRoot: '/some/path',
    });
    // doctor-verify still runs
    runDoctorChecksMock.mockResolvedValueOnce(makeBaseChecks());
    checkCodexCliMock.mockReturnValue({ name: 'codex-cli', status: 'ok', detail: 'ok' });
    checkCodexPluginNpmMock.mockReturnValue({ name: 'codex-plugin-npm', status: 'ok', detail: 'ok' });
    checkCodexPluginRegisteredMock.mockReturnValue({ name: 'codex-plugin-registered', status: 'ok', detail: 'ok' });

    const { exitCode } = await runCli(
      registerCodexCommand,
      ['--profile', 'staging', '--config', '/tmp/sb.json',
       'codex', 'repair', '--skip', 'remove-plugin'],
    );
    expect(exitCode).toBe(0);
    // Find the spawn call corresponding to re-auth (stdio: 'inherit' is the marker)
    const reAuthCall = spawnSyncRepairMock.mock.calls.find(
      (call) => (call[2] as { stdio?: string } | undefined)?.stdio === 'inherit',
    );
    expect(reAuthCall).toBeDefined();
    if (!reAuthCall) return;
    const [exe, argv] = reAuthCall as [string, string[], unknown];
    expect(exe).toBe(process.execPath);
    expect(argv).toContain('--config');
    expect(argv).toContain('/tmp/sb.json');
    expect(argv).toContain('--profile');
    expect(argv).toContain('staging');
    expect(argv.slice(-2)).toEqual(['auth', 'login']);
  });

  // A1 (negative): no --config passed → argv must NOT contain --config
  it('re-auth omits --config from argv when no global --config is set', async () => {
    runDoctorChecksMock.mockResolvedValueOnce([
      { name: 'node', status: 'ok', detail: 'ok' },
      { name: 'path', status: 'ok', detail: 'ok' },
    ]);
    tryLoadConfigMock.mockReturnValue(null);
    spawnSyncRepairMock.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    registerCodexPluginMock.mockReturnValueOnce({
      ok: true, pluginId: 'switchbot@codex-plugin', packageRoot: '/some/path',
    });
    runDoctorChecksMock.mockResolvedValueOnce(makeBaseChecks());
    checkCodexCliMock.mockReturnValue({ name: 'codex-cli', status: 'ok', detail: 'ok' });
    checkCodexPluginNpmMock.mockReturnValue({ name: 'codex-plugin-npm', status: 'ok', detail: 'ok' });
    checkCodexPluginRegisteredMock.mockReturnValue({ name: 'codex-plugin-registered', status: 'ok', detail: 'ok' });

    await runCli(
      registerCodexCommand,
      ['codex', 'repair', '--skip', 'remove-plugin'],
    );
    const reAuthCall = spawnSyncRepairMock.mock.calls.find(
      (call) => (call[2] as { stdio?: string } | undefined)?.stdio === 'inherit',
    );
    expect(reAuthCall).toBeDefined();
    if (!reAuthCall) return;
    const argv = reAuthCall[1] as string[];
    expect(argv).not.toContain('--config');
    // default profile → also no --profile in argv
    expect(argv).not.toContain('--profile');
  });
});

// ─── codex setup (C5) ────────────────────────────────────────────────────────

describe('switchbot codex setup', () => {
  beforeEach(() => {
    spawnSyncRepairMock.mockReset();
    runDoctorChecksMock.mockReset();
    checkCodexCliMock.mockReset();
    checkCodexPluginNpmMock.mockReset();
    checkCodexPluginRegisteredMock.mockReset();
    registerCodexPluginMock.mockReset();
    tryLoadConfigMock.mockReset();
  });

  it('--dry-run prints the 6-step list without mutating', async () => {
    const { exitCode, stderr } = await runCli(
      registerCodexCommand,
      ['codex', 'setup', '--dry-run'],
    );
    expect(exitCode).toBe(0);
    const out = stderr.join('\n');
    expect(out).toContain('check-codex-cli');
    expect(out).toContain('install-switchbot-cli');
    expect(out).toContain('install-codex-plugin');
    expect(out).toContain('register-plugin');
    expect(out).toContain('auth');
    expect(out).toContain('doctor-verify');
    expect(out).toContain('No changes made');
    expect(spawnSyncRepairMock).not.toHaveBeenCalled();
    expect(registerCodexPluginMock).not.toHaveBeenCalled();
  });

  it('--dry-run --json emits 6 ordered steps with skippable flags', async () => {
    const { exitCode, stdout } = await runCli(
      registerCodexCommand,
      ['codex', 'setup', '--dry-run', '--json'],
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.join('')) as {
      data?: { dryRun: boolean; steps: Array<{ name: string; skippable: boolean; willSkip: boolean }> };
      dryRun?: boolean;
      steps?: Array<{ name: string; skippable: boolean; willSkip: boolean }>;
    };
    const data = parsed.data ?? parsed;
    expect(data.dryRun).toBe(true);
    expect(data.steps).toHaveLength(6);
    expect(data.steps?.map((s) => s.name)).toEqual([
      'check-codex-cli', 'install-switchbot-cli', 'install-codex-plugin', 'register-plugin', 'auth', 'doctor-verify',
    ]);
    const skippable = Object.fromEntries(data.steps!.map((s) => [s.name, s.skippable]));
    expect(skippable['install-switchbot-cli']).toBe(true);
    expect(skippable['install-codex-plugin']).toBe(true);
    expect(skippable['auth']).toBe(true);
    expect(skippable['check-codex-cli']).toBe(false);
    expect(skippable['register-plugin']).toBe(false);
    expect(skippable['doctor-verify']).toBe(false);
  });

  it('exits 2 with "not skippable" when --skip targets a non-skippable step', async () => {
    const { exitCode, stderr } = await runCli(
      registerCodexCommand,
      ['codex', 'setup', '--skip', 'register-plugin'],
    );
    expect(exitCode).toBe(2);
    expect(stderr.join('\n')).toContain("invalid --skip: 'register-plugin' is not skippable");
  });

  it('exits 2 when check-codex-cli fails (preflight)', async () => {
    checkCodexCliMock.mockReturnValueOnce({
      name: 'codex-cli', status: 'fail', detail: { message: 'codex CLI not found on PATH' },
    });
    const { exitCode, stdout } = await runCli(
      registerCodexCommand,
      ['codex', 'setup', '--json'],
    );
    expect(exitCode).toBe(2);
    const parsed = JSON.parse(stdout.join('')) as {
      data?: { ok: boolean; preflightFailed: boolean; outcomes: Array<{ step: string; status: string }> };
    };
    const data = parsed.data!;
    expect(data.preflightFailed).toBe(true);
    // Only the first step ran — subsequent steps must be absent
    expect(data.outcomes).toHaveLength(1);
    expect(data.outcomes[0].step).toBe('check-codex-cli');
    expect(data.outcomes[0].status).toBe('failed');
    // register-plugin must NOT have been called when preflight short-circuits
    expect(registerCodexPluginMock).not.toHaveBeenCalled();
  });

  it('--yes with credentials missing returns failed auth without spawning auth login', async () => {
    checkCodexCliMock.mockReturnValueOnce({
      name: 'codex-cli', status: 'ok', detail: { path: '/usr/local/bin/codex', version: 'codex 1.2.3' },
    });
    // install-switchbot-cli step: npm list -g returns the package as already installed
    spawnSyncRepairMock.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ dependencies: { '@switchbot/openapi-cli': { version: '1.0.0' } } }),
      stderr: '',
    });
    // install-codex-plugin step: npm list -g returns the package as already installed
    spawnSyncRepairMock.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ dependencies: { '@switchbot/codex-plugin': { version: '0.1.0' } } }),
      stderr: '',
    });
    // register-plugin succeeds
    registerCodexPluginMock.mockReturnValueOnce({
      ok: true, pluginId: 'switchbot@codex-plugin',
      packageRoot: '/usr/local/lib/node_modules/@switchbot/codex-plugin',
    });
    // credentials missing
    tryLoadConfigMock.mockReturnValue(null);
    // doctor-verify still runs (4 base + 3 codex)
    runDoctorChecksMock.mockResolvedValueOnce(makeBaseChecks());
    checkCodexCliMock.mockReturnValue({ name: 'codex-cli', status: 'ok', detail: 'ok' });
    checkCodexPluginNpmMock.mockReturnValue({ name: 'codex-plugin-npm', status: 'ok', detail: 'ok' });
    checkCodexPluginRegisteredMock.mockReturnValue({ name: 'codex-plugin-registered', status: 'ok', detail: 'ok' });

    const { exitCode, stdout } = await runCli(
      registerCodexCommand,
      ['codex', 'setup', '--yes', '--json'],
    );
    expect(exitCode).toBe(1); // anyFailed → 1, not preflight (which would be 2)
    const parsed = JSON.parse(stdout.join('')) as {
      data?: { outcomes: Array<{ step: string; status: string; message?: string }> };
    };
    const auth = parsed.data!.outcomes.find((o) => o.step === 'auth');
    expect(auth?.status).toBe('failed');
    expect(auth?.message).toContain('credentials-missing');
    // No interactive spawn (stdio: 'inherit') was made
    const inheritCall = spawnSyncRepairMock.mock.calls.find(
      (call) => (call[2] as { stdio?: string } | undefined)?.stdio === 'inherit',
    );
    expect(inheritCall).toBeUndefined();
  });

  it('forwards --config and --profile to spawned auth login (interactive mode)', async () => {
    checkCodexCliMock.mockReturnValueOnce({
      name: 'codex-cli', status: 'ok', detail: { path: '/usr/local/bin/codex' },
    });
    // install-switchbot-cli: already installed
    spawnSyncRepairMock.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ dependencies: { '@switchbot/openapi-cli': { version: '1.0.0' } } }),
      stderr: '',
    });
    // install-codex-plugin: already installed
    spawnSyncRepairMock.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ dependencies: { '@switchbot/codex-plugin': { version: '0.1.0' } } }),
      stderr: '',
    });
    registerCodexPluginMock.mockReturnValueOnce({
      ok: true, pluginId: 'switchbot@codex-plugin', packageRoot: '/some/path',
    });
    // credentials missing → spawn auth login
    tryLoadConfigMock.mockReturnValue(null);
    // The auth-login spawn returns ok
    spawnSyncRepairMock.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    // doctor-verify
    runDoctorChecksMock.mockResolvedValueOnce(makeBaseChecks());
    checkCodexCliMock.mockReturnValue({ name: 'codex-cli', status: 'ok', detail: 'ok' });
    checkCodexPluginNpmMock.mockReturnValue({ name: 'codex-plugin-npm', status: 'ok', detail: 'ok' });
    checkCodexPluginRegisteredMock.mockReturnValue({ name: 'codex-plugin-registered', status: 'ok', detail: 'ok' });

    await runCli(
      registerCodexCommand,
      ['--profile', 'prod', '--config', '/etc/sb.json', 'codex', 'setup', '--json'],
    );
    const inheritCall = spawnSyncRepairMock.mock.calls.find(
      (call) => (call[2] as { stdio?: string } | undefined)?.stdio === 'inherit',
    );
    expect(inheritCall).toBeDefined();
    if (!inheritCall) return;
    const [exe, argv] = inheritCall as [string, string[], unknown];
    expect(exe).toBe(process.execPath);
    expect(argv).toContain('--profile');
    expect(argv).toContain('prod');
    expect(argv).toContain('--config');
    expect(argv).toContain('/etc/sb.json');
    expect(argv.slice(-2)).toEqual(['auth', 'login']);
  });

  it('--skip install-switchbot-cli marks the step as skipped and continues', async () => {
    checkCodexCliMock.mockReturnValueOnce({
      name: 'codex-cli', status: 'ok', detail: { path: '/usr/local/bin/codex' },
    });
    // install-codex-plugin still runs when only install-switchbot-cli is skipped
    spawnSyncRepairMock.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ dependencies: { '@switchbot/codex-plugin': { version: '0.1.0' } } }),
      stderr: '',
    });
    registerCodexPluginMock.mockReturnValueOnce({
      ok: true, pluginId: 'switchbot@codex-plugin', packageRoot: '/some/path',
    });
    // credentials present → auth ok without spawn
    tryLoadConfigMock.mockReturnValue({ token: 't', secret: 's' });
    runDoctorChecksMock.mockResolvedValueOnce(makeBaseChecks());
    checkCodexCliMock.mockReturnValue({ name: 'codex-cli', status: 'ok', detail: 'ok' });
    checkCodexPluginNpmMock.mockReturnValue({ name: 'codex-plugin-npm', status: 'ok', detail: 'ok' });
    checkCodexPluginRegisteredMock.mockReturnValue({ name: 'codex-plugin-registered', status: 'ok', detail: 'ok' });

    const { exitCode, stdout } = await runCli(
      registerCodexCommand,
      ['codex', 'setup', '--skip', 'install-switchbot-cli', '--json'],
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.join('')) as {
      data?: { outcomes: Array<{ step: string; status: string }> };
    };
    const step = parsed.data!.outcomes.find((o) => o.step === 'install-switchbot-cli');
    expect(step?.status).toBe('skipped');
    // npm list -g was NOT spawned for install-switchbot-cli; the only npm call was the plugin check.
    expect(spawnSyncRepairMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncRepairMock.mock.calls[0][1]).toContain('@switchbot/codex-plugin');
  });

  it('install-switchbot-cli failure exits 1 (not 2 — only check-codex-cli is preflight)', async () => {
    checkCodexCliMock.mockReturnValueOnce({
      name: 'codex-cli', status: 'ok', detail: { path: '/usr/local/bin/codex' },
    });
    // npm list -g says not installed
    spawnSyncRepairMock.mockReturnValueOnce({ status: 1, stdout: '{}', stderr: '' });
    // npm install -g fails
    spawnSyncRepairMock.mockReturnValueOnce({ status: 1, stdout: '', stderr: 'EACCES' });
    // install-codex-plugin still runs
    spawnSyncRepairMock.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ dependencies: { '@switchbot/codex-plugin': { version: '0.1.0' } } }),
      stderr: '',
    });
    // register-plugin still runs (continues after non-preflight failure)
    registerCodexPluginMock.mockReturnValueOnce({
      ok: true, pluginId: 'switchbot@codex-plugin', packageRoot: '/some/path',
    });
    // auth: credentials present
    tryLoadConfigMock.mockReturnValue({ token: 't', secret: 's' });
    // doctor-verify
    runDoctorChecksMock.mockResolvedValueOnce(makeBaseChecks());
    checkCodexCliMock.mockReturnValue({ name: 'codex-cli', status: 'ok', detail: 'ok' });
    checkCodexPluginNpmMock.mockReturnValue({ name: 'codex-plugin-npm', status: 'ok', detail: 'ok' });
    checkCodexPluginRegisteredMock.mockReturnValue({ name: 'codex-plugin-registered', status: 'ok', detail: 'ok' });

    const { exitCode, stdout } = await runCli(
      registerCodexCommand,
      ['codex', 'setup', '--json'],
    );
    expect(exitCode).toBe(1); // anyFailed but not preflight → 1
    const parsed = JSON.parse(stdout.join('')) as {
      data?: { preflightFailed: boolean; outcomes: Array<{ step: string; status: string }> };
    };
    expect(parsed.data!.preflightFailed).toBe(false);
    expect(parsed.data!.outcomes).toHaveLength(6); // all 6 steps ran (no preflight halt)
    expect(parsed.data!.outcomes.find((o) => o.step === 'install-switchbot-cli')?.status).toBe('failed');
    // register-plugin still got called despite the earlier failure
    expect(registerCodexPluginMock).toHaveBeenCalledOnce();
  });

  it('installs @switchbot/codex-plugin before registering when missing', async () => {
    checkCodexCliMock.mockReturnValueOnce({
      name: 'codex-cli', status: 'ok', detail: { path: '/usr/local/bin/codex' },
    });
    // switchbot CLI already installed
    spawnSyncRepairMock.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ dependencies: { '@switchbot/openapi-cli': { version: '1.0.0' } } }),
      stderr: '',
    });
    // codex plugin missing, then install succeeds
    spawnSyncRepairMock.mockReturnValueOnce({ status: 1, stdout: '{}', stderr: '' });
    spawnSyncRepairMock.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    registerCodexPluginMock.mockReturnValueOnce({
      ok: true, pluginId: 'switchbot@codex-plugin', packageRoot: '/some/path',
    });
    tryLoadConfigMock.mockReturnValue({ token: 't', secret: 's' });
    runDoctorChecksMock.mockResolvedValueOnce(makeBaseChecks());
    checkCodexCliMock.mockReturnValue({ name: 'codex-cli', status: 'ok', detail: 'ok' });
    checkCodexPluginNpmMock.mockReturnValue({ name: 'codex-plugin-npm', status: 'ok', detail: 'ok' });
    checkCodexPluginRegisteredMock.mockReturnValue({ name: 'codex-plugin-registered', status: 'ok', detail: 'ok' });

    const { exitCode, stdout } = await runCli(
      registerCodexCommand,
      ['codex', 'setup', '--json'],
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.join('')) as {
      data?: { outcomes: Array<{ step: string; status: string; message?: string }> };
    };
    const pluginStep = parsed.data!.outcomes.find((o) => o.step === 'install-codex-plugin');
    expect(pluginStep?.status).toBe('ok');
    expect(pluginStep?.message).toContain('installed @switchbot/codex-plugin@latest');
    expect(spawnSyncRepairMock.mock.calls[1][1]).toEqual(['list', '-g', '--json', '--depth=0', '@switchbot/codex-plugin']);
    expect(spawnSyncRepairMock.mock.calls[2][1]).toEqual(['install', '-g', '@switchbot/codex-plugin@latest']);
    expect(registerCodexPluginMock).toHaveBeenCalledOnce();
  });
});
