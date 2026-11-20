import { expect, it } from 'vitest';
import { registerDevicesCommand } from '../../src/commands/devices.js';
import { registerSchemaCommand } from '../../src/commands/schema.js';
import type { CommandSpec, ReadOnlyQuerySpec } from '../../src/devices/catalog.js';
import { runCli } from '../helpers/cli.js';

it('exports the documented controls, status and safety boundaries for the updated models', async () => {
  const result = await runCli(registerSchemaCommand, ['schema', 'export', '--types',
    'Floor Cleaning Robot S30,Hub 4,Vision Doorbell,Plug Mini (IT),Outdoor Plug (EU),AI Art Frame,AI Art Frame Luma',
  ]);
  const { data: { types } } = JSON.parse(result.stdout.join('')) as {
    data: { types: { type: string; commands: CommandSpec[]; statusFields: string[]; readOnly: boolean }[] };
  };
  const models = new Map(types.map((entry) => [entry.type, entry]));
  const s30 = models.get('Robot Vacuum Cleaner S30');
  expect(s30?.commands.map((c) => c.command).sort()).toEqual(['changeParam', 'dock', 'pause', 'selfClean', 'setVolume', 'startClean']);
  expect(s30?.commands.find((c) => c.command === 'selfClean')?.exampleParams).toEqual(['1', '2', '3', '4']);
  expect(s30?.statusFields.sort()).toEqual(['battery', 'onlineStatus', 'taskType', 'waterBaseBattery', 'workingStatus']);

  for (const [type, status] of [
    ['Hub 4', ['humidity', 'lightLevel', 'moveDetected', 'onlineStatus', 'temperature', 'version']],
    ['Vision Doorbell', ['battery', 'online', 'version']],
  ] as const) {
    expect(models.get(type)).toMatchObject({ readOnly: true, commands: [] });
    expect(models.get(type)?.statusFields.sort()).toEqual(status);
  }
  for (const type of ['Plug Mini (IT)', 'Outdoor Plug (EU)']) {
    const plug = models.get(type);
    expect(plug?.commands.map((c) => c.command).sort()).toEqual(['toggle', 'turnOff', 'turnOn']);
    expect(plug?.statusFields.sort()).toEqual(['electricCurrent', 'onlineStatus', 'power', 'switchStatus', 'usedElectricity', 'version', 'voltage']);
  }
  for (const type of ['AI Art Frame', 'AI Art Frame 2']) {
    expect(models.get(type)?.commands.find((c) => c.command === 'deleteImage')).toMatchObject({
      idempotent: false, safetyTier: 'destructive', safetyReason: expect.stringMatching(/permanent|recover/i),
      exampleParams: ['random', 'newest', 'oldest'],
    });
  }
});

it('distinguishes relay state from measured power, current and daily energy in plug discovery', async () => {
  const plugs = ['Plug Mini (IT)', 'Outdoor Plug (EU)'];
  const result = await runCli(registerDevicesCommand, ['devices', 'commands', ...plugs, '--json']);
  const { data } = JSON.parse(result.stdout.join('')) as {
    data: { type: string; statusQueries?: ReadOnlyQuerySpec[] }[];
  };
  expect(data.map((plug) => plug.type)).toEqual(plugs);
  for (const plug of data) {
    const fields = Object.fromEntries((plug.statusQueries ?? []).map((q) => [q.field, q.description]));
    expect(fields).toMatchObject({
      switchStatus: expect.stringMatching(/0.*off.*1.*on/i),
      voltage: expect.stringMatching(/volts/i),
      power: expect.stringMatching(/watts/i),
      electricCurrent: expect.stringMatching(/mA/),
      usedElectricity: expect.stringMatching(/daily.*watt-minutes/i),
    });
  }
  const schema = await runCli(registerSchemaCommand, ['schema', 'export', '--types', plugs.join(',')]);
  const { data: { types } } = JSON.parse(schema.stdout.join('')) as { data: { types: { description: string }[] } };
  for (const entry of types) {
    expect(entry.description).toMatch(/watts.*mA.*daily.*watt-minutes/i);
  }
});
