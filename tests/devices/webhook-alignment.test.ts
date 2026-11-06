import { describe, expect, it } from 'vitest';
import { registerSchemaCommand } from '../../src/commands/schema.js';
import { runCli } from '../helpers/cli.js';

describe('webhook resource discovery alignment', () => {
  it('discovers the EU Plug webhook context as Plug Mini (EU) with documented event fields', async () => {
    const result = await runCli(registerSchemaCommand, ['schema', 'export']);
    const data = JSON.parse(result.stdout.join('')) as {
      data: {
        resources: {
          webhooks: {
            events: Array<{
              eventType: string;
              eventVersion: string;
              context: {
                deviceType: string;
                fields: Array<{ name: string; type: string }>;
              };
            }>;
          };
        };
      };
    };

    const event = data.data.resources.webhooks.events.find(
      ({ context }) => context.deviceType === 'Plug Mini (EU)',
    );

    expect(event).toMatchObject({ eventType: 'changeReport', eventVersion: '1' });
    expect(event?.context.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'deviceMac', type: 'string' }),
      expect.objectContaining({ name: 'online', type: 'boolean' }),
      expect.objectContaining({ name: 'switchStatus', type: 'number' }),
    ]));
  });
  it('discovers all five confirmed webhook identities with their documented context fields', async () => {
    const result = await runCli(registerSchemaCommand, ['schema', 'export']);
    // This test exercises the typed schema command directly through its public CLI output.
    const schemaExport = JSON.parse(result.stdout.join('')) as {
      data: {
        resources: {
          webhooks: {
            events: Array<{
              eventType: string;
              eventVersion: string;
              context: {
                deviceType: string;
                fields: Array<{ name: string; type: string }>;
              };
            }>;
          };
        };
      };
    };
    const events = schemaExport.data.resources.webhooks.events;

    const expectedFields: Record<string, Array<[string, string]>> = {
      WoCurtain4: [
        ['deviceMac', 'string'],
        ['calibrate', 'boolean'],
        ['group', 'boolean'],
        ['slidePosition', 'number'],
        ['battery', 'number'],
        ['timeOfSample', 'timestamp'],
      ],
      'Smart Lock Ultra Max': [
        ['deviceMac', 'string'],
        ['lockState', 'string'],
        ['battery', 'number'],
        ['timeOfSample', 'timestamp'],
      ],
      'Robot Vacuum Cleaner K11 Plus Pro': [
        ['deviceMac', 'string'],
        ['workingStatus', 'string'],
        ['onlineStatus', 'string'],
        ['battery', 'number'],
        ['waterBaseBattery', 'number'],
        ['taskType', 'string'],
        ['timeOfSample', 'timestamp'],
      ],
      'AI Art Frame Luma': [
        ['deviceMac', 'string'],
        ['displayMode', 'number'],
        ['battery', 'number'],
        ['timeOfSample', 'timestamp'],
      ],
      'Solar Pan/Tilt Cam 2K': [
        ['deviceMac', 'string'],
        ['battery', 'number'],
        ['detectionState', 'string'],
        ['timeOfSample', 'timestamp'],
      ],
    };

    for (const [deviceType, fields] of Object.entries(expectedFields)) {
      const event = events.find(({ context }) => context.deviceType === deviceType);

      expect(event).toMatchObject({ eventType: 'changeReport', eventVersion: '1' });
      expect(event?.context.fields).toEqual(expect.arrayContaining(
        fields.map(([name, type]) => expect.objectContaining({ name, type })),
      ));
    }
  });
});
