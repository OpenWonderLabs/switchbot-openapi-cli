import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/install/gemini-checks.js', () => ({
  checkGeminiCli:    vi.fn(() => ({ name: 'check-gemini-cli',    status: 'ok', detail: { version: '0.1.12' } })),
  checkMcpRegistered: vi.fn(() => ({ name: 'check-mcp-registered', status: 'ok', detail: 'registered' })),
  registerMcp:        vi.fn(() => ({ ok: true })),
  GEMINI_SETTINGS_PATH: '/home/user/.gemini/settings.json',
}));

vi.mock('../../src/commands/doctor.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    runDoctorChecks: vi.fn(async () => []),
    formatDoctorChecks: vi.fn(),
  };
});

import { buildProgram } from '../../src/program-builder.js';

describe('gemini command registration', () => {
  it('registers gemini command on the root program', () => {
    const program = buildProgram();
    expect(program.commands.find((c) => c.name() === 'gemini')).toBeDefined();
  });

  it('registers setup subcommand', () => {
    const program = buildProgram();
    const gemini = program.commands.find((c) => c.name() === 'gemini')!;
    expect(gemini.commands.find((c) => c.name() === 'setup')).toBeDefined();
  });

  it('registers doctor subcommand', () => {
    const program = buildProgram();
    const gemini = program.commands.find((c) => c.name() === 'gemini')!;
    expect(gemini.commands.find((c) => c.name() === 'doctor')).toBeDefined();
  });

  it('setup has --skip option', () => {
    const program = buildProgram();
    const setup = program.commands
      .find((c) => c.name() === 'gemini')!.commands
      .find((c) => c.name() === 'setup')!;
    expect(setup.options.some((o) => o.long === '--skip')).toBe(true);
  });

  it('setup has --yes option', () => {
    const program = buildProgram();
    const setup = program.commands
      .find((c) => c.name() === 'gemini')!.commands
      .find((c) => c.name() === 'setup')!;
    expect(setup.options.some((o) => o.long === '--yes')).toBe(true);
  });
});

describe('gemini setup --dry-run', () => {
  let exitMock: ReturnType<typeof vi.spyOn>;
  let logMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitMock = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logMock  = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitMock.mockRestore();
    logMock.mockRestore();
  });

  it('prints all 6 step names without executing anything', async () => {
    const program = buildProgram();
    await program.parseAsync(['node', 'switchbot', 'gemini', 'setup', '--dry-run']);
    const output = logMock.mock.calls.flat().join('\n');
    expect(output).toContain('check-gemini-cli');
    expect(output).toContain('check-network');
    expect(output).toContain('install-switchbot-cli');
    expect(output).toContain('register-mcp');
    expect(output).toContain('auth');
    expect(output).toContain('doctor-verify');
    expect(exitMock).toHaveBeenCalledWith(0);
  });
});
