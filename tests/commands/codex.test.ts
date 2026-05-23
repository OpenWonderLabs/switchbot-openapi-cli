import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCli } from '../helpers/cli.js';
import { registerCodexCommand } from '../../src/commands/codex.js';

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
