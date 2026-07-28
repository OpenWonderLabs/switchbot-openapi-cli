import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCli } from '../helpers/cli.js';
import { registerClaudeCodeCommand } from '../../src/commands/claude-code.js';

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

const runDoctorChecksMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/commands/doctor.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, runDoctorChecks: runDoctorChecksMock };
});

const checkClaudeCodeCliMock = vi.hoisted(() => vi.fn());
const checkMcpRegisteredMock = vi.hoisted(() => vi.fn());
const registerMcpMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/install/claude-code-checks.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    checkClaudeCodeCli: checkClaudeCodeCliMock,
    checkMcpRegistered: checkMcpRegisteredMock,
    registerMcp: registerMcpMock,
  };
});

const tryLoadConfigMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, tryLoadConfig: tryLoadConfigMock };
});

const okCli   = { name: 'check-claude-cli',     status: 'ok'   as const, detail: { version: '1.0.0' } };
const failCli  = { name: 'check-claude-cli',     status: 'fail' as const, detail: 'claude not found' };
const okMcp    = { name: 'check-mcp-registered', status: 'ok'   as const, detail: 'registered' };
const failMcp  = { name: 'check-mcp-registered', status: 'fail' as const, detail: 'not registered' };

function baseChecks() {
  return [
    { name: 'node', status: 'ok' as const, detail: 'ok' },
    { name: 'path', status: 'ok' as const, detail: 'ok' },
    { name: 'credentials', status: 'ok' as const, detail: 'ok' },
    { name: 'mcp', status: 'ok' as const, detail: 'ok' },
  ];
}

function mockSpawnOk() {
  spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'npm' && args[0] === 'ping')  return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'npm' && args[0] === 'list')  return {
      status: 0,
      stdout: JSON.stringify({ dependencies: { '@switchbot/openapi-cli': { version: '3.7.6' } } }),
      stderr: '',
    };
    return { status: 0, stdout: '', stderr: '' };
  });
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  runDoctorChecksMock.mockReset();
  checkClaudeCodeCliMock.mockReset();
  checkMcpRegisteredMock.mockReset();
  registerMcpMock.mockReset();
  tryLoadConfigMock.mockReset();
});

function run(extraArgs: string[] = []) {
  return runCli(registerClaudeCodeCommand, ['claude-code', 'setup', '--yes', ...extraArgs]);
}

// ── Preflight ─────────────────────────────────────────────────────────────────

describe('claude-code setup — check-claude-cli (preflight)', () => {
  it('exits 2 and reports failed when claude CLI not found', async () => {
    checkClaudeCodeCliMock.mockReturnValue(failCli);
    const res = await run();
    expect(res.exitCode).toBe(2);
    expect(res.stdout.join(' ')).toMatch(/Preflight failed|install Claude Code/i);
  });

  it('exits 0 when already configured (fast path)', async () => {
    checkClaudeCodeCliMock.mockReturnValue(okCli);
    checkMcpRegisteredMock.mockReturnValue(okMcp);
    tryLoadConfigMock.mockReturnValue({ token: 'tok', secret: 'sec' });

    const res = await run();
    expect(res.exitCode).toBe(0);
    expect(res.stdout.join(' ')).toMatch(/already configured/i);
  });
});

// ── register-mcp ─────────────────────────────────────────────────────────────

describe('claude-code setup — register-mcp step', () => {
  beforeEach(() => {
    checkClaudeCodeCliMock.mockReturnValue(okCli);
    // First call: isAlreadyConfigured → fail (triggers full pipeline)
    // Subsequent calls (doctor-verify): ok
    checkMcpRegisteredMock
      .mockReturnValueOnce(failMcp)
      .mockReturnValue(okMcp);
    tryLoadConfigMock.mockReturnValue({ token: 'tok', secret: 'sec' });
    runDoctorChecksMock.mockResolvedValue(baseChecks());
    mockSpawnOk();
  });

  it('exits 0 when register-mcp succeeds (calls claude mcp add)', async () => {
    registerMcpMock.mockReturnValue({ ok: true });
    const res = await run();
    expect(res.exitCode).toBe(0);
    expect(registerMcpMock).toHaveBeenCalledOnce();
  });

  it('exits 1 when register-mcp fails', async () => {
    registerMcpMock.mockReturnValue({ ok: false, error: 'claude mcp add failed (exit 1): permission denied' });
    const res = await run();
    expect(res.exitCode).toBe(1);
    expect(res.stdout.join(' ')).toMatch(/permission denied/i);
  });

  it('shows alreadyRegistered message when already in mcp list', async () => {
    registerMcpMock.mockReturnValue({ ok: true, alreadyRegistered: true });
    const res = await run();
    expect(res.exitCode).toBe(0);
    expect(res.stdout.join(' ')).toMatch(/already registered/i);
  });
});

// ── auth step ─────────────────────────────────────────────────────────────────

describe('claude-code setup — auth step', () => {
  beforeEach(() => {
    checkClaudeCodeCliMock.mockReturnValue(okCli);
    checkMcpRegisteredMock
      .mockReturnValueOnce(failMcp)
      .mockReturnValue(okMcp);
    runDoctorChecksMock.mockResolvedValue(baseChecks());
    registerMcpMock.mockReturnValue({ ok: true });
    mockSpawnOk();
  });

  it('skips auth login when credentials already present', async () => {
    tryLoadConfigMock.mockReturnValue({ token: 'tok', secret: 'sec' });
    const res = await run();
    expect(res.exitCode).toBe(0);
    expect(res.stdout.join(' ')).toMatch(/credentials present/i);
  });

  it('reports failed with --yes when credentials missing', async () => {
    tryLoadConfigMock.mockReturnValue(null);
    const res = await run();
    expect(res.exitCode).toBe(1);
    expect(res.stdout.join(' ')).toMatch(/credentials-missing/i);
  });
});

// ── --skip validation ─────────────────────────────────────────────────────────

describe('claude-code setup — --skip validation', () => {
  it('exits 2 for non-skippable step name', async () => {
    const res = await runCli(registerClaudeCodeCommand, ['claude-code', 'setup', '--skip', 'register-mcp']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join(' ')).toMatch(/invalid --skip/i);
  });

  it('skips skippable steps and still completes ok', async () => {
    checkClaudeCodeCliMock.mockReturnValue(okCli);
    // skip.size > 0 → fast path not called → no mockReturnValueOnce needed
    checkMcpRegisteredMock.mockReturnValue(okMcp);
    tryLoadConfigMock.mockReturnValue({ token: 'tok', secret: 'sec' });
    runDoctorChecksMock.mockResolvedValue(baseChecks());
    registerMcpMock.mockReturnValue({ ok: true });
    mockSpawnOk();

    const res = await runCli(registerClaudeCodeCommand, [
      'claude-code', 'setup', '--yes', '--skip', 'auth,install-switchbot-cli',
    ]);
    expect(res.exitCode).toBe(0);
    // Skipped steps still appear in output (with · symbol), non-skipped steps show ✓
    expect(res.stdout.join(' ')).toMatch(/install-switchbot-cli/i);
  });
});

// ── --json output ─────────────────────────────────────────────────────────────

describe('claude-code setup — JSON output', () => {
  it('emits ok:true on success', async () => {
    checkClaudeCodeCliMock.mockReturnValue(okCli);
    checkMcpRegisteredMock
      .mockReturnValueOnce(failMcp)
      .mockReturnValue(okMcp);
    tryLoadConfigMock.mockReturnValue({ token: 'tok', secret: 'sec' });
    runDoctorChecksMock.mockResolvedValue(baseChecks());
    registerMcpMock.mockReturnValue({ ok: true });
    mockSpawnOk();

    const res = await runCli(registerClaudeCodeCommand, ['--json', 'claude-code', 'setup', '--yes']);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout[0]) as Record<string, unknown>;
    const data = (parsed['data'] ?? parsed) as Record<string, unknown>;
    expect(data).toHaveProperty('ok', true);
    expect(data).toHaveProperty('outcomes');
  });
});

// ── unit: checkMcpRegistered ──────────────────────────────────────────────────

describe('checkMcpRegistered (unit — real implementation)', () => {
  it('returns ok when switchbot appears in claude mcp list output', async () => {
    const { checkMcpRegistered } = await vi.importActual<typeof import('../../src/install/claude-code-checks.js')>(
      '../../src/install/claude-code-checks.js',
    );
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'switchbot  stdio  switchbot mcp serve\n', stderr: '' });
    expect(checkMcpRegistered().status).toBe('ok');
  });

  it('returns fail when switchbot absent from output', async () => {
    const { checkMcpRegistered } = await vi.importActual<typeof import('../../src/install/claude-code-checks.js')>(
      '../../src/install/claude-code-checks.js',
    );
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'other-server  stdio  other-cmd\n', stderr: '' });
    expect(checkMcpRegistered().status).toBe('fail');
  });

  it('returns fail when claude mcp list exits non-zero', async () => {
    const { checkMcpRegistered } = await vi.importActual<typeof import('../../src/install/claude-code-checks.js')>(
      '../../src/install/claude-code-checks.js',
    );
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'error' });
    expect(checkMcpRegistered().status).toBe('fail');
  });
});

// ── unit: registerMcp ─────────────────────────────────────────────────────────

describe('registerMcp (unit — real implementation)', () => {
  it('returns alreadyRegistered when switchbot already in mcp list', async () => {
    const { registerMcp } = await vi.importActual<typeof import('../../src/install/claude-code-checks.js')>(
      '../../src/install/claude-code-checks.js',
    );
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'switchbot  stdio\n', stderr: '' });
    const r = registerMcp();
    expect(r.ok).toBe(true);
    expect(r.alreadyRegistered).toBe(true);
  });

  it('calls claude mcp add when not registered and returns ok on success', async () => {
    const { registerMcp } = await vi.importActual<typeof import('../../src/install/claude-code-checks.js')>(
      '../../src/install/claude-code-checks.js',
    );
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: 'other-server\n', stderr: '' })  // mcp list
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });               // mcp add
    const r = registerMcp();
    expect(r.ok).toBe(true);
    expect(r.alreadyRegistered).toBeUndefined();
    const addCall = spawnSyncMock.mock.calls[1] as [string, string[]];
    expect(addCall[0]).toBe('claude');
    expect(addCall[1]).toContain('add');
    expect(addCall[1]).toContain('--scope');
    expect(addCall[1]).toContain('user');
  });

  it('returns error when claude mcp add fails', async () => {
    const { registerMcp } = await vi.importActual<typeof import('../../src/install/claude-code-checks.js')>(
      '../../src/install/claude-code-checks.js',
    );
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })               // mcp list → not found
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'access denied' }); // mcp add → fail
    const r = registerMcp();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/access denied/);
  });
});
