import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerCapabilitiesCommand } from '../../src/commands/capabilities.js';

/** Build a representative program that mirrors the real CLI structure. */
function makeProgram(): Command {
  const p = new Command();
  p.name('switchbot').version('2.1.0');
  p.option('--json', 'Output raw JSON response');
  p.option('--format <type>', 'Output format');
  p.option('--fields <csv>', 'Column filter');
  p.option('--dry-run', 'Print mutating requests without sending them');
  p.option('--verbose', 'Log HTTP details');

  const devices = p.command('devices').description('Control and query devices');
  devices.command('list').description('List all devices');
  devices.command('status').description('Get device status');
  devices.command('command').description('Send a command');
  const describe = devices.command('describe').description('Show full device info');
  describe.argument('<id>', 'Device ID');
  describe.option('--json', 'JSON output');

  p.command('scenes').description('List and run scenes');
  p.command('schema').description('Export device catalog');
  p.command('mcp').description('Start MCP server');
  p.command('plan').description('Execute batch plans');

  return p;
}

async function runCapabilities(): Promise<Record<string, unknown>> {
  const program = makeProgram();
  program.exitOverride();

  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map(String).join(' '));
  });

  registerCapabilitiesCommand(program);

  try {
    await program.parseAsync(['node', 'test', 'capabilities']);
  } finally {
    logSpy.mockRestore();
  }

  return JSON.parse(chunks.join('')) as Record<string, unknown>;
}

describe('capabilities', () => {
  it('outputs valid JSON with all top-level keys', async () => {
    const out = await runCapabilities();
    expect(out).toHaveProperty('version');
    expect(out).toHaveProperty('generatedAt');
    expect(out).toHaveProperty('identity');
    expect(out).toHaveProperty('surfaces');
    expect(out).toHaveProperty('commands');
    expect(out).toHaveProperty('globalFlags');
    expect(out).toHaveProperty('catalog');
  });

  it('identity.product is SwitchBot and quota is 10000', async () => {
    const out = await runCapabilities();
    const id = out.identity as Record<string, unknown>;
    expect(id.product).toBe('SwitchBot');
    expect((id.constraints as Record<string, unknown>).quotaPerDay).toBe(10000);
  });

  it('commands list includes known top-level commands', async () => {
    const out = await runCapabilities();
    const names = (out.commands as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain('devices');
    expect(names).toContain('scenes');
    expect(names).toContain('schema');
  });

  it('devices command entry has non-empty subcommands including "list"', async () => {
    const out = await runCapabilities();
    const devices = (out.commands as Array<{ name: string; subcommands: Array<{ name: string }> }>).find(
      (c) => c.name === 'devices',
    );
    expect(devices).toBeDefined();
    expect(Array.isArray(devices!.subcommands)).toBe(true);
    expect(devices!.subcommands.length).toBeGreaterThan(0);
    const subNames = devices!.subcommands.map((s) => s.name);
    expect(subNames).toContain('list');
  });

  it('devices describe subcommand has args and flags', async () => {
    const out = await runCapabilities();
    type Sub = { name: string; args: Array<{ name: string; required: boolean }>; flags: Array<{ flags: string }> };
    const devices = (out.commands as Array<{ name: string; subcommands: Sub[] }>).find(
      (c) => c.name === 'devices',
    );
    const describe = devices!.subcommands.find((s) => s.name === 'describe');
    expect(describe).toBeDefined();
    expect(describe!.args.length).toBeGreaterThan(0);
    expect(describe!.args[0].name).toBeTruthy();
    expect(typeof describe!.args[0].required).toBe('boolean');
    expect(Array.isArray(describe!.flags)).toBe(true);
  });

  it('globalFlags includes --json and --dry-run', async () => {
    const out = await runCapabilities();
    const flags = (out.globalFlags as Array<{ flags: string }>).map((f) => f.flags);
    expect(flags.some((f) => f.includes('--json'))).toBe(true);
    expect(flags.some((f) => f.includes('--dry-run'))).toBe(true);
  });

  it('catalog.roles includes lighting and security, typeCount > 10', async () => {
    const out = await runCapabilities();
    const cat = out.catalog as Record<string, unknown>;
    expect((cat.roles as string[])).toContain('lighting');
    expect((cat.roles as string[])).toContain('security');
    expect(cat.typeCount as number).toBeGreaterThan(10);
  });

  it('surfaces.mcp.tools has 7 entries including send_command', async () => {
    const out = await runCapabilities();
    const tools = (out.surfaces as Record<string, { tools: string[] }>).mcp.tools;
    expect(tools).toHaveLength(7);
    expect(tools).toContain('send_command');
  });

  it('version matches semver format', async () => {
    const out = await runCapabilities();
    expect(out.version as string).toMatch(/^\d+\.\d+\.\d+/);
  });
});
