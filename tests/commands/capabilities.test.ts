import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerCapabilitiesCommand } from '../../src/commands/capabilities.js';

/** Build a representative program that mirrors the real CLI structure. */
function makeProgram(): Command {
  const p = new Command();
  p.name('switchbot').version('0.0.0-test');
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
  // devices meta subcommands (bug #40)
  const meta = devices.command('meta').description('Manage local device metadata');
  meta.command('set').description('Set metadata for a device');
  meta.command('get').description('Get metadata for a device');
  meta.command('list').description('List all device metadata');
  meta.command('clear').description('Clear metadata for a device');

  const history = p.command('history').description('Device history and aggregation');
  history.command('aggregate').description('Aggregate device history');

  const scenes = p.command('scenes').description('List and run scenes');
  scenes.command('list').description('List scenes');
  scenes.command('execute').description('Execute a scene');
  scenes.command('describe').description('Describe a scene');

  const schema = p.command('schema').description('Export device catalog');
  schema.command('export').description('Export schema');

  const mcp = p.command('mcp').description('Start MCP server');
  mcp.command('serve').description('Serve MCP');

  const plan = p.command('plan').description('Execute batch plans');
  plan.command('schema').description('Plan schema');
  plan.command('validate').description('Validate a plan');
  plan.command('run').description('Run a plan');

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

  return (JSON.parse(chunks.join('')) as { data: Record<string, unknown> }).data;
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

  it('catalog is a pointer note with typeCount, not inline stats', async () => {
    const out = await runCapabilities();
    const cat = out.catalog as Record<string, unknown>;
    expect(cat).toHaveProperty('note');
    expect(cat.note as string).toContain('schema export');
    expect(cat.typeCount as number).toBeGreaterThan(10);
    // Inline stats (roles, safetyTiersInUse, readOnlyQueryCount) are intentionally
    // removed — they now live in `schema export --capabilities`.
    expect(cat.roles).toBeUndefined();
    expect(cat.safetyTiersInUse).toBeUndefined();
  });

  it('surfaces.mcp.tools includes send_command, account_overview, get_device_history and query_device_history', async () => {
    const out = await runCapabilities();
    const mcp = (out.surfaces as Record<string, { tools: string[]; resources: string[] }>).mcp;
    expect(mcp.tools.length).toBeGreaterThanOrEqual(9);
    expect(mcp.tools).toContain('send_command');
    expect(mcp.tools).toContain('account_overview');
    expect(mcp.tools).toContain('get_device_history');
    expect(mcp.tools).toContain('query_device_history');
    expect(mcp.resources).toEqual(['switchbot://events']);
  });

  it('surfaces.mqtt exposes authSource, cliCmd, mcpResource, and protocol', async () => {
    const out = await runCapabilities();
    const mqtt = (out.surfaces as Record<string, Record<string, unknown>>).mqtt;
    expect(mqtt).toBeDefined();
    expect(mqtt.mode).toBe('consumer');
    expect(typeof mqtt.authSource).toBe('string');
    expect((mqtt.authSource as string)).toContain('SWITCHBOT_TOKEN');
    expect(mqtt.cliCmd).toBe('events mqtt-tail');
    expect(mqtt.mcpResource).toBe('switchbot://events');
    expect(mqtt.protocol).toMatch(/MQTTS/);
  });

  it('version matches semver format', async () => {
    const out = await runCapabilities();
    expect(out.version as string).toMatch(/^\d+\.\d+\.\d+/);
  });
});

async function runCapabilitiesWith(extra: string[]): Promise<Record<string, unknown>> {
  const program = makeProgram();
  program.exitOverride();
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map(String).join(' '));
  });
  registerCapabilitiesCommand(program);
  try {
    await program.parseAsync(['node', 'test', 'capabilities', ...extra]);
  } finally {
    logSpy.mockRestore();
  }
  return (JSON.parse(chunks.join('')) as { data: Record<string, unknown> }).data;
}

describe('capabilities B3/B4', () => {
  it('--compact emits a flat leaf-command list with safety metadata', async () => {
    const out = await runCapabilitiesWith(['--compact']);
    const cmds = out.commands as Array<Record<string, unknown>>;
    expect(Array.isArray(cmds)).toBe(true);
    // compact leaves are flat and every entry has the safety metadata.
    for (const c of cmds) {
      expect(c).toHaveProperty('agentSafetyTier');
      expect(c).toHaveProperty('mutating');
      expect(c).toHaveProperty('consumesQuota');
      expect(c).toHaveProperty('idempotencySupported');
    }
  });

  it('exposes agentGuide.safetyTiers definitions', async () => {
    const out = await runCapabilitiesWith([]);
    const guide = out.agentGuide as Record<string, Record<string, string>>;
    expect(guide.safetyTiers.read).toBeTruthy();
    expect(guide.safetyTiers.action).toBeTruthy();
    expect(guide.safetyTiers.destructive).toBeTruthy();
  });

  it('known leaf commands carry expected agentSafetyTier values', async () => {
    const out = await runCapabilitiesWith(['--compact']);
    const cmds = out.commands as Array<{ name: string; agentSafetyTier: string }>;
    const byName = Object.fromEntries(cmds.map((c) => [c.name, c.agentSafetyTier]));
    expect(byName['devices list']).toBe('read');
    expect(byName['devices command']).toBe('action');
  });

  it('--surface mcp restricts surfaces block to mcp only', async () => {
    const out = await runCapabilitiesWith(['--surface', 'mcp']);
    const surfaces = out.surfaces as Record<string, unknown>;
    expect(Object.keys(surfaces)).toEqual(['mcp']);
  });

  it('surfaces.cli exposes idempotencyContract with replay + conflict semantics', async () => {
    const out = await runCapabilitiesWith([]);
    const cli = (out.surfaces as Record<string, Record<string, unknown>>).cli;
    expect(cli.idempotencyContract).toBeDefined();
    const ic = cli.idempotencyContract as Record<string, unknown>;
    expect(ic.flag).toBe('--idempotency-key <key>');
    expect(ic.windowSeconds).toBe(60);
    expect(ic.replayBehavior).toMatch(/replayed:true/);
  });

  it('exposes history aggregate as a read-tier leaf', async () => {
    const out = await runCapabilitiesWith(['--compact']);
    const cmds = out.commands as Array<{ name: string; agentSafetyTier: string; mutating: boolean }>;
    const agg = cmds.find((c) => c.name === 'history aggregate');
    expect(agg).toBeDefined();
    expect(agg!.agentSafetyTier).toBe('read');
    expect(agg!.mutating).toBe(false);
  });

  it('surfaces.mcp.tools includes aggregate_device_history', async () => {
    const out = await runCapabilitiesWith([]);
    const mcp = (out.surfaces as Record<string, { tools: string[] }>).mcp;
    expect(mcp.tools).toContain('aggregate_device_history');
  });

  it('devices meta set appears in compact capabilities output (bug #40)', async () => {
    const out = await runCapabilitiesWith(['--compact']);
    const cmds = out.commands as Array<{ name: string; agentSafetyTier: string; mutating: boolean }>;
    const metaSet = cmds.find((c) => c.name === 'devices meta set');
    expect(metaSet).toBeDefined();
    expect(metaSet!.agentSafetyTier).toBe('action');
    expect(metaSet!.mutating).toBe(true);
  });

  it('fails closed when a leaf command is missing metadata', async () => {
    const program = makeProgram();
    program.command('mystery').description('Unknown leaf');
    program.exitOverride();
    const chunks: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      chunks.push(args.map(String).join(' '));
    });
    registerCapabilitiesCommand(program);
    await expect(program.parseAsync(['node', 'test', 'capabilities'])).rejects.toThrow(/missing:mystery/);
    logSpy.mockRestore();
  });

  it('P15: resources catalog exposes scenes / webhooks / keys', async () => {
    const out = await runCapabilitiesWith([]);
    const resources = out.resources as Record<string, unknown>;
    expect(resources).toBeDefined();
    expect(resources.scenes).toBeDefined();
    expect(resources.webhooks).toBeDefined();
    expect(Array.isArray(resources.keys)).toBe(true);
    const webhooks = resources.webhooks as { events: Array<{ eventType: string }>; endpoints: Array<{ verb: string }> };
    expect(webhooks.events.length).toBeGreaterThanOrEqual(10);
    expect(webhooks.endpoints.map((e) => e.verb).sort()).toEqual(['delete', 'query', 'setup', 'update']);
    const keys = resources.keys as Array<{ keyType: string }>;
    expect(keys.map((k) => k.keyType).sort()).toEqual(['disposable', 'permanent', 'timeLimit', 'urgent']);
  });
});
