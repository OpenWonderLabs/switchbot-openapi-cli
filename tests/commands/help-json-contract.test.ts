import { describe, it, expect, beforeAll } from 'vitest';
import { Command } from 'commander';
import { commandToJson, type CommandJson } from '../../src/utils/help-json.js';
import { registerConfigCommand } from '../../src/commands/config.js';
import { registerDevicesCommand } from '../../src/commands/devices.js';
import { registerScenesCommand } from '../../src/commands/scenes.js';
import { registerWebhookCommand } from '../../src/commands/webhook.js';
import { registerCompletionCommand } from '../../src/commands/completion.js';
import { registerMcpCommand } from '../../src/commands/mcp.js';
import { registerQuotaCommand } from '../../src/commands/quota.js';
import { registerCatalogCommand } from '../../src/commands/catalog.js';
import { registerCacheCommand } from '../../src/commands/cache.js';
import { registerEventsCommand } from '../../src/commands/events.js';
import { registerDoctorCommand } from '../../src/commands/doctor.js';
import { registerSchemaCommand } from '../../src/commands/schema.js';
import { registerHistoryCommand } from '../../src/commands/history.js';
import { registerPlanCommand } from '../../src/commands/plan.js';
import { registerCapabilitiesCommand } from '../../src/commands/capabilities.js';
import { registerAgentBootstrapCommand } from '../../src/commands/agent-bootstrap.js';

const TOP_LEVEL_COMMANDS = [
  'config',
  'devices',
  'scenes',
  'webhook',
  'completion',
  'mcp',
  'quota',
  'catalog',
  'cache',
  'events',
  'doctor',
  'schema',
  'history',
  'plan',
  'capabilities',
  'agent-bootstrap',
] as const;

function buildProgram(): Command {
  const program = new Command();
  program.name('switchbot').description('Command-line tool for SwitchBot API v1.1').version('0.0.0-test');
  registerConfigCommand(program);
  registerDevicesCommand(program);
  registerScenesCommand(program);
  registerWebhookCommand(program);
  registerCompletionCommand(program);
  registerMcpCommand(program);
  registerQuotaCommand(program);
  registerCatalogCommand(program);
  registerCacheCommand(program);
  registerEventsCommand(program);
  registerDoctorCommand(program);
  registerSchemaCommand(program);
  registerHistoryCommand(program);
  registerPlanCommand(program);
  registerCapabilitiesCommand(program);
  registerAgentBootstrapCommand(program);
  return program;
}

describe('help --json contract coverage', () => {
  let program: Command;

  beforeAll(() => {
    program = buildProgram();
  });

  it('all 16 top-level commands are registered', () => {
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual([...TOP_LEVEL_COMMANDS].sort());
  });

  describe.each(TOP_LEVEL_COMMANDS)('top-level command: %s', (cmdName) => {
    let target: Command;
    let json: CommandJson;

    beforeAll(() => {
      const match = program.commands.find((c) => c.name() === cmdName);
      if (!match) throw new Error(`command ${cmdName} not registered`);
      target = match;
      json = commandToJson(target);
    });

    it('has non-empty name matching registration', () => {
      expect(json.name).toBe(cmdName);
      expect(json.name.length).toBeGreaterThan(0);
    });

    it('has a non-empty description', () => {
      expect(typeof json.description).toBe('string');
      expect(json.description.length).toBeGreaterThan(0);
    });

    it('arguments field is an array (possibly empty)', () => {
      expect(Array.isArray(json.arguments)).toBe(true);
      for (const a of json.arguments) {
        expect(a.name).toBeTypeOf('string');
        expect(a.name.length).toBeGreaterThan(0);
        expect(a.required).toBeTypeOf('boolean');
        expect(a.variadic).toBeTypeOf('boolean');
      }
    });

    it('options field is an array; each has flags + description', () => {
      expect(Array.isArray(json.options)).toBe(true);
      for (const opt of json.options) {
        expect(opt.flags).toBeTypeOf('string');
        expect(opt.flags.length).toBeGreaterThan(0);
        expect(opt.description).toBeTypeOf('string');
      }
    });

    it('options never include the auto --help or --version entries', () => {
      const flagsList = json.options.map((o) => o.flags);
      expect(flagsList).not.toContain('-h, --help');
      expect(flagsList).not.toContain('-V, --version');
    });

    it('subcommands field is an array; each entry has name + description', () => {
      expect(Array.isArray(json.subcommands)).toBe(true);
      for (const sub of json.subcommands) {
        expect(sub.name).toBeTypeOf('string');
        expect(sub.name.length).toBeGreaterThan(0);
        expect(sub.description).toBeTypeOf('string');
        // Subcommand descriptions should not be empty, but some commander
        // defaults can land without one — don't force it, just surface a
        // failure when someone forgets.
        expect(sub.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe('subcommand recursion: commands with subcommands expose each sub', () => {
    it('devices subtree has the expected core verbs', () => {
      const devices = program.commands.find((c) => c.name() === 'devices');
      expect(devices).toBeDefined();
      const subNames = devices!.commands.map((c) => c.name());
      for (const verb of ['list', 'status', 'describe', 'command', 'batch']) {
        expect(subNames).toContain(verb);
      }
    });

    it('every subcommand reachable from the program tree is individually serializable', () => {
      function walk(cmd: Command): void {
        const json = commandToJson(cmd);
        expect(json.name).toBeTypeOf('string');
        expect(json.name.length).toBeGreaterThan(0);
        expect(Array.isArray(json.arguments)).toBe(true);
        expect(Array.isArray(json.options)).toBe(true);
        expect(Array.isArray(json.subcommands)).toBe(true);
        for (const s of cmd.commands) walk(s);
      }
      for (const top of program.commands) walk(top);
    });
  });
});
