import { describe, expect, it } from 'vitest';
import { registerSchemaCommand } from '../../src/commands/schema.js';
import type { WebhookEventSpec } from '../../src/devices/resources.js';
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
  it('discovers official changeReport contexts without treating status-only Vision Doorbell as an event source', async () => {
    const result = await runCli(registerSchemaCommand, ['schema', 'export']);
    // Check the public metadata consumed by webhook clients, not the source catalog.
    const schemaExport = JSON.parse(result.stdout.join('')) as {
      data: { resources: { webhooks: { events: WebhookEventSpec[] } } };
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
      'AI Art Frame 2': [
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

    const plugFields = { online: 'boolean', overTemperature: 'boolean', overload: 'boolean', switchStatus: 'number' };
    for (const [type, fields] of Object.entries({
      'Robot Vacuum Cleaner S30': {
        workingStatus: 'string', onlineStatus: 'string', battery: 'number', waterBaseBattery: 'number', taskType: 'string',
      },
      'Hub 4': {
        detectionState: 'string', humidity: 'number', lightLevel: 'number', scale: 'string', temperature: 'number',
      },
      'Plug Mini (IT)': plugFields,
      'Outdoor Plug (EU)': plugFields,
    })) {
      const event = events.find(({ context }) => context.deviceType === type);
      expect(event).toMatchObject({ eventType: 'changeReport', eventVersion: '1', devicePattern: type });
      expect(Object.fromEntries(event!.context.fields.map((f) => [f.name, f.type]))).toEqual({
        deviceMac: 'string', timeOfSample: 'timestamp', ...fields,
      });
    }
    const s30 = events.find(({ context }) => context.deviceType === 'Robot Vacuum Cleaner S30')!;
    for (const field of s30.context.fields.filter((f) => !['deviceMac', 'timeOfSample'].includes(f.name))) {
      expect(field.description).toMatch(/only.*chang/i);
    }
    expect(events.map((e) => e.context.deviceType)).not.toContain('Vision Doorbell');
    expect(events.map((e) => e.context.deviceType)).not.toContain('AI Art Frame Luma');
  });
});
