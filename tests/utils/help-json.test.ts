import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { commandToJson, resolveTargetCommand } from '../../src/utils/help-json.js';

describe('commandToJson', () => {
  it('serializes name, description, arguments, options, subcommands', () => {
    const cmd = new Command('test')
      .description('Test command')
      .argument('<bar>', 'A required bar argument')
      .argument('[baz]', 'An optional baz argument')
      .option('--foo <value>', 'A foo option', 'default-foo')
      .option('--flag', 'A boolean flag');
    cmd.command('sub').description('A subcommand');

    const result = commandToJson(cmd);
    expect(result.name).toBe('test');
    expect(result.description).toBe('Test command');
    expect(result.arguments).toEqual([
      { name: 'bar', required: true, variadic: false, description: 'A required bar argument' },
      { name: 'baz', required: false, variadic: false, description: 'An optional baz argument' },
    ]);
    expect(result.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ flags: '--foo <value>', description: 'A foo option', defaultValue: 'default-foo' }),
        expect.objectContaining({ flags: '--flag', description: 'A boolean flag' }),
      ])
    );
    expect(result.subcommands).toEqual([{ name: 'sub', description: 'A subcommand' }]);
  });

  it('excludes --help and --version from options', () => {
    const cmd = new Command('root').version('1.0.0').option('--json', 'JSON mode');
    const result = commandToJson(cmd);
    const flags = result.options.map((o) => o.flags);
    expect(flags).not.toContain('-h, --help');
    expect(flags).not.toContain('-V, --version');
    expect(flags).toContain('--json');
  });

  it('includes choices when defined', () => {
    const cmd = new Command('test');
    cmd.addOption(
      new (require('commander').Option)('--format <type>', 'Output format').choices(['json', 'table', 'tsv'])
    );
    const result = commandToJson(cmd);
    const formatOpt = result.options.find((o) => o.flags.includes('--format'));
    expect(formatOpt?.choices).toEqual(['json', 'table', 'tsv']);
  });
});

describe('resolveTargetCommand', () => {
  it('returns root when no subcommand matches', () => {
    const root = new Command('switchbot');
    const result = resolveTargetCommand(root, ['--json', '--help']);
    expect(result.name()).toBe('switchbot');
  });

  it('descends into a matching subcommand', () => {
    const root = new Command('switchbot');
    const devices = root.command('devices').description('Devices');
    devices.command('list').description('List devices');

    const result = resolveTargetCommand(root, ['devices', '--help', '--json']);
    expect(result.name()).toBe('devices');
  });

  it('descends into a nested subcommand', () => {
    const root = new Command('switchbot');
    const devices = root.command('devices');
    devices.command('list');

    const result = resolveTargetCommand(root, ['devices', 'list', '--help']);
    expect(result.name()).toBe('list');
  });

  it('resolves command aliases', () => {
    const root = new Command('switchbot');
    root.command('devices').alias('d');

    const result = resolveTargetCommand(root, ['d', '--help']);
    expect(result.name()).toBe('devices');
  });
});
