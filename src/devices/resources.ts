/**
 * Declarative metadata for non-device resources exposed by the SwitchBot API:
 * scenes, webhooks, and keypad credentials ("keys").
 *
 * Consumed by `capabilities --json` and `schema export` so AI agents can
 * discover these surfaces the same way they discover device commands.
 *
 * Scope:
 * - Descriptive metadata only (no runtime execution — CLI/MCP handlers stay
 *   source-of-truth for behavior).
 * - Webhook event entries are pinned to documented Cloud API v1.1 examples.
 *   They are advisory discovery metadata, not a validator: fields can be
 *   absent for a documented device or event variant.
 */

export type ResourceSafetyTier = 'read' | 'mutation' | 'destructive';

export interface SceneOperation {
  verb: 'list' | 'execute';
  method: 'GET' | 'POST';
  endpoint: string;
  params: ReadonlyArray<{ name: string; required: boolean; type: string }>;
  safetyTier: ResourceSafetyTier;
}

export interface SceneSpec {
  description: string;
  operations: ReadonlyArray<SceneOperation>;
}

export interface WebhookEndpoint {
  verb: 'setup' | 'query' | 'update' | 'delete';
  method: 'POST';
  path: string;
  safetyTier: ResourceSafetyTier;
  requiredParams: ReadonlyArray<string>;
}

export type WebhookEventFieldType = 'string' | 'number' | 'boolean' | 'timestamp' | 'object';

export interface WebhookEventField {
  name: string;
  type: WebhookEventFieldType;
  description: string;
  example?: unknown;
  fields?: ReadonlyArray<WebhookEventField>;
}

export interface WebhookEventContext {
  deviceType: string;
  fields: ReadonlyArray<WebhookEventField>;
}

export interface WebhookEventSpec {
  eventType: 'changeReport';
  eventVersion: '1';
  devicePattern: string;
  context: WebhookEventContext;
}

export interface WebhookCatalog {
  endpoints: ReadonlyArray<WebhookEndpoint>;
  events: ReadonlyArray<WebhookEventSpec>;
}

export interface KeySpec {
  keyType: 'permanent' | 'timeLimit' | 'disposable' | 'urgent';
  description: string;
  requiredParams: ReadonlyArray<string>;
  optionalParams: ReadonlyArray<string>;
  supportedDevices: ReadonlyArray<string>;
  safetyTier: 'destructive';
}

export interface ResourceCatalog {
  version: '2.0';
  scenes: SceneSpec;
  webhooks: WebhookCatalog;
  keys: ReadonlyArray<KeySpec>;
}

const COMMON_WEBHOOK_CONTEXT_FIELDS: ReadonlyArray<WebhookEventField> = [
  { name: 'deviceMac', type: 'string', description: 'Device MAC address where documented.', example: 'AA:BB:CC:11:22:33' },
  { name: 'timeOfSample', type: 'timestamp', description: 'Millisecond Unix timestamp when the sample was taken', example: 1700000000000 },
];

export const RESOURCE_CATALOG: ResourceCatalog = {
  version: '2.0',
  scenes: {
    description: 'Manual scenes (IFTTT-style rules) authored in the SwitchBot app. Execution is fire-and-forget from the cloud — side-effects happen on the user\'s devices.',
    operations: [
      {
        verb: 'list',
        method: 'GET',
        endpoint: '/v1.1/scenes',
        params: [],
        safetyTier: 'read',
      },
      {
        verb: 'execute',
        method: 'POST',
        endpoint: '/v1.1/scenes/{sceneId}/execute',
        params: [{ name: 'sceneId', required: true, type: 'string' }],
        safetyTier: 'mutation',
      },
    ],
  },

  webhooks: {
    endpoints: [
      {
        verb: 'setup',
        method: 'POST',
        path: '/v1.1/webhook/setupWebhook',
        safetyTier: 'mutation',
        requiredParams: ['url'],
      },
      {
        verb: 'query',
        method: 'POST',
        path: '/v1.1/webhook/queryWebhook',
        safetyTier: 'read',
        requiredParams: ['action'],
      },
      {
        verb: 'update',
        method: 'POST',
        path: '/v1.1/webhook/updateWebhook',
        safetyTier: 'mutation',
        requiredParams: ['url', 'enable'],
      },
      {
        verb: 'delete',
        method: 'POST',
        path: '/v1.1/webhook/deleteWebhook',
        safetyTier: 'destructive',
        requiredParams: ['url'],
      },
    ],
    events: [
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Meter',
        context: {
          deviceType: 'WoMeter',
          fields: [
          ...COMMON_WEBHOOK_CONTEXT_FIELDS,
          { name: 'temperature', type: 'number', description: 'Current temperature reading in Celsius.', example: 22.5 },
          { name: 'scale', type: 'string', description: 'Current temperature unit.', example: 'CELSIUS' },
          { name: 'humidity', type: 'number', description: 'Current relative humidity percentage.', example: 45 },
          { name: 'battery', type: 'number', description: 'Battery remaining (%)', example: 88 },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Meter Plus',
        context: {
          deviceType: 'WoMeterPlus',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'temperature', type: 'number', description: 'Current temperature reading in Celsius.' },
            { name: 'scale', type: 'string', description: 'Current temperature unit.' },
            { name: 'humidity', type: 'number', description: 'Current relative humidity percentage.' },
            { name: 'battery', type: 'number', description: 'Current battery percentage.' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Meter Pro CO2',
        context: {
          deviceType: 'MeterPro(CO2)',
          fields: [
          ...COMMON_WEBHOOK_CONTEXT_FIELDS,
          { name: 'temperature', type: 'number', description: 'Current temperature reading in Celsius.' },
          { name: 'scale', type: 'string', description: 'Current temperature unit.' },
          { name: 'humidity', type: 'number', description: 'Current relative humidity percentage.' },
          { name: 'CO2', type: 'number', description: 'CO2 concentration in ppm.', example: 1203 },
          { name: 'battery', type: 'number', description: 'Current battery percentage.' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Motion Sensor',
        context: {
          deviceType: 'WoPresence',
          fields: [
          ...COMMON_WEBHOOK_CONTEXT_FIELDS,
          { name: 'detectionState', type: 'string', description: 'Detection result word', example: 'DETECTED' },
          { name: 'battery', type: 'number', description: 'Battery remaining (%)' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Contact Sensor',
        context: {
          deviceType: 'WoContact',
          fields: [
          ...COMMON_WEBHOOK_CONTEXT_FIELDS,
          { name: 'openState', type: 'string', description: 'Door/window state', example: 'open' },
          { name: 'detectionState', type: 'string', description: 'Motion detection state reported by the callback.' },
          { name: 'doorMode', type: 'string', description: 'Door event mode reported by the callback.' },
          { name: 'brightness', type: 'string', description: 'Ambient brightness category.' },
          { name: 'battery', type: 'number', description: 'Battery remaining (%)' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Smart Lock',
        context: {
          deviceType: 'WoLock',
          fields: [
          ...COMMON_WEBHOOK_CONTEXT_FIELDS,
          { name: 'lockState', type: 'string', description: 'Lock state: locked, unlocked, jammed', example: 'locked' },
          { name: 'battery', type: 'number', description: 'Battery remaining (%)' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Plug Mini (US)',
        context: {
          deviceType: 'WoPlugUS',
          fields: [
          ...COMMON_WEBHOOK_CONTEXT_FIELDS,
          { name: 'powerState', type: 'string', description: 'Current power state: ON or OFF.', example: 'ON' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Plug Mini (JP)',
        context: {
          deviceType: 'WoPlugJP',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'powerState', type: 'string', description: 'Current power state: ON or OFF.' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Plug Mini (EU)',
        context: {
          deviceType: 'WoPlugEU',
          fields: [
            { name: 'deviceMac', type: 'string', description: 'Device MAC address.' },
            { name: 'online', type: 'boolean', description: 'Whether the plug is connected.' },
            { name: 'overTemperature', type: 'boolean', description: 'Whether the plug is over temperature.' },
            { name: 'overload', type: 'boolean', description: 'Whether the plug is overloaded.' },
            { name: 'switchStatus', type: 'number', description: 'Switch state: 0 off, 1 on.' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Relay Switch 1',
        context: {
          deviceType: 'Relay Switch 1',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'online', type: 'boolean', description: 'Whether the relay is connected.' },
            { name: 'overTemperature', type: 'boolean', description: 'Whether the relay is over temperature.' },
            { name: 'switchStatus', type: 'number', description: 'Switch state: 0 off, 1 on.' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Relay Switch 2PM',
        context: {
          deviceType: 'Relay Switch 2PM',
          fields: [
            { name: 'deviceMac', type: 'string', description: 'Device MAC address.' },
            { name: 'online', type: 'boolean', description: 'Whether the relay is connected.' },
            { name: 'overTemperature', type: 'boolean', description: 'Whether the relay is over temperature.' },
            { name: 'switch1Status', type: 'number', description: 'Channel 1 state: 0 off, 1 on.' },
            { name: 'switch2Status', type: 'number', description: 'Channel 2 state: 0 off, 1 on.' },
            { name: 'switch1Overload', type: 'boolean', description: 'Channel 1 overload state.' },
            { name: 'switch2Overload', type: 'boolean', description: 'Channel 2 overload state.' },
            { name: 'calibrate', type: 'boolean', description: 'Whether positions are calibrated.' },
            { name: 'position', type: 'number', description: 'Open or closed position percentage.' },
            { name: 'isStuck', type: 'boolean', description: 'Whether the device is stuck.' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Relay Switch 1PM',
        context: {
          deviceType: 'Relay Switch 1PM',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'online', type: 'boolean', description: 'Whether the relay is connected.' },
            { name: 'overTemperature', type: 'boolean', description: 'Whether the relay is over temperature.' },
            { name: 'overload', type: 'boolean', description: 'Whether the relay is overloaded.' },
            { name: 'switchStatus', type: 'number', description: 'Switch state: 0 off, 1 on.' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Bot',
        context: {
          deviceType: 'WoHand',
          fields: [
          ...COMMON_WEBHOOK_CONTEXT_FIELDS,
          { name: 'power', type: 'string', description: 'Power state (on/off)' },
          { name: 'battery', type: 'number', description: 'Battery remaining (%)' },
          { name: 'deviceMode', type: 'string', description: 'Bot operating mode reported by the event.' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Curtain',
        context: {
          deviceType: 'WoCurtain',
          fields: [
          ...COMMON_WEBHOOK_CONTEXT_FIELDS,
          { name: 'slidePosition', type: 'number', description: 'Current slide position (0–100)' },
          { name: 'calibrate', type: 'boolean', description: 'True if device is calibrated' },
          { name: 'group', type: 'boolean', description: 'Whether the curtain belongs to a group.' },
          { name: 'battery', type: 'number', description: 'Battery remaining (%)' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Roller Shade',
        context: {
          deviceType: 'WoRollerShade',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'calibrate', type: 'boolean', description: 'Whether positions are calibrated.' },
            { name: 'slidePosition', type: 'number', description: 'Current position percentage.' },
            { name: 'battery', type: 'number', description: 'Current battery percentage.' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Video Doorbell',
        context: {
          deviceType: 'Video Doorbell',
          fields: [
          ...COMMON_WEBHOOK_CONTEXT_FIELDS,
          { name: 'battery', type: 'number', description: 'Current battery percentage.' },
          { name: 'detectionState', type: 'string', description: 'Motion detection state.' },
          { name: 'press', type: 'boolean', description: 'Whether the doorbell button was pressed.' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Keypad scan / createKey result / deleteKey result',
        context: {
          deviceType: 'WoKeypad',
          fields: [
          ...COMMON_WEBHOOK_CONTEXT_FIELDS,
          { name: 'eventName', type: 'string', description: 'Name of the asynchronously completed command.' },
          { name: 'commandId', type: 'string', description: 'Correlation id returned by the original command' },
          { name: 'result', type: 'string', description: 'Outcome (success / failed / timeout)' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Color Bulb',
        context: {
          deviceType: 'WoBulb',
          fields: [
          ...COMMON_WEBHOOK_CONTEXT_FIELDS,
          { name: 'powerState', type: 'string', description: 'Current power state: ON or OFF.' },
          { name: 'brightness', type: 'number', description: 'Brightness (1–100).' },
          { name: 'color', type: 'string', description: 'RGB triplet "r:g:b"' },
          { name: 'colorTemperature', type: 'number', description: 'Color temperature in Kelvin' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Strip Light',
        context: {
          deviceType: 'WoStrip',
          fields: [
          ...COMMON_WEBHOOK_CONTEXT_FIELDS,
          { name: 'powerState', type: 'string', description: 'Current power state: ON or OFF.' },
          { name: 'brightness', type: 'number', description: 'Brightness (1–100).' },
          { name: 'color', type: 'string', description: 'RGB triplet "r:g:b"' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Robot Vacuum Cleaner S10',
        context: {
          deviceType: 'Robot Vacuum Cleaner S10',
          fields: [
          ...COMMON_WEBHOOK_CONTEXT_FIELDS,
          { name: 'workingStatus', type: 'string', description: 'Cleaning state' },
          { name: 'battery', type: 'number', description: 'Battery remaining (%)' },
          { name: 'taskType', type: 'string', description: 'Current task (standby / clean / charge)' },
          { name: 'onlineStatus', type: 'string', description: 'Connection status.' },
          { name: 'waterBaseBattery', type: 'number', description: 'Water-base battery remaining (%).' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Water Leak Detector',
        context: {
          deviceType: 'Water Detector',
          fields: [
          ...COMMON_WEBHOOK_CONTEXT_FIELDS,
          { name: 'detectionState', type: 'number', description: 'Leak state: 0 dry, 1 leak detected.' },
          { name: 'battery', type: 'number', description: 'Battery remaining (%)' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Hub 2',
        context: {
          deviceType: 'WoHub2',
          fields: [
          ...COMMON_WEBHOOK_CONTEXT_FIELDS,
          { name: 'temperature', type: 'number', description: 'Current temperature reading in Celsius.' },
          { name: 'humidity', type: 'number', description: 'Current relative humidity percentage.' },
          { name: 'lightLevel', type: 'number', description: 'Ambient illuminance level.' },
          { name: 'scale', type: 'string', description: 'Current temperature unit.' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Hub 3',
        context: {
          deviceType: 'Hub 3',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'detectionState', type: 'string', description: 'Motion detection state.' },
            { name: 'temperature', type: 'number', description: 'Current temperature reading in Celsius.' },
            { name: 'scale', type: 'string', description: 'Current temperature unit.' },
            { name: 'humidity', type: 'number', description: 'Current relative humidity percentage.' },
            { name: 'lightLevel', type: 'number', description: 'Ambient illuminance level.' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'AI MindClip',
        context: {
          deviceType: 'AI MindClip',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            {
              name: 'chargeUploadCompleted',
              type: 'object',
              description: 'Charge upload completion event.',
              fields: [
                { name: 'fileID', type: 'string', description: 'Recording file ID.' },
                { name: 'fileName', type: 'string', description: 'Recording file name.' },
                { name: 'status', type: 'number', description: 'Upload status; 1 means completed.' },
                { name: 'timestamp', type: 'timestamp', description: 'Completion time in Unix milliseconds.' },
              ],
            },
            {
              name: 'transcription',
              type: 'object',
              description: 'Transcription status event.',
              fields: [
                { name: 'fileID', type: 'string', description: 'Recording file ID.' },
                { name: 'status', type: 'number', description: 'Transcription status.' },
                { name: 'timestamp', type: 'timestamp', description: 'Event time in Unix milliseconds.' },
              ],
            },
            { name: 'dailySummary', type: 'timestamp', description: 'Daily summary generation time in Unix seconds.' },
            { name: 'weeklySummary', type: 'timestamp', description: 'Weekly summary generation time in Unix seconds.' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Kata Friends',
        context: {
          deviceType: 'Kata Friends',
          fields: [
            { name: 'deviceId', type: 'string', description: 'Device ID.' },
            { name: 'version', type: 'string', description: 'Current firmware version.' },
            { name: 'battery', type: 'number', description: 'Current battery percentage.' },
            { name: 'onlineStatus', type: 'string', description: 'Connection status.' },
            { name: 'mode', type: 'string', description: 'Current device mode.' },
            { name: 'status', type: 'string', description: 'Current device status.' },
            { name: 'childLock', type: 'string', description: 'Child lock state.' },
            { name: 'hospitalized', type: 'number', description: 'Service state.' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'AI Art Frame',
        context: {
          deviceType: 'AI Art Frame',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'displayMode', type: 'number', description: 'display mode: 0 = Static image; 1 = Slideshow' },
            { name: 'battery', type: 'number', description: 'the current battery level, 0-100' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Air Purifier PM2.5',
        context: {
          deviceType: 'Air Purifier PM2.5',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'power', type: 'string', description: 'the power state of the device' },
            { name: 'mode', type: 'number', description: 'the current mode. `1`, normal or fan mode; `2`, auto mode; `3`, sleep mode; `4`, pet mode' },
            { name: 'childLock', type: 'number', description: 'child lock. `0`, disabled; `1`, enabled' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Air Purifier Table PM2.5',
        context: {
          deviceType: 'Air Purifier Table PM2.5',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'power', type: 'string', description: 'the power state of the device' },
            { name: 'mode', type: 'number', description: 'the current mode. `1`, normal or fan mode; `2`, auto mode; `3`, sleep mode; `4`, pet mode' },
            { name: 'childLock', type: 'number', description: 'child lock. `0`, disabled; `1`, enabled' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Air Purifier Table VOC',
        context: {
          deviceType: 'Air Purifier Table VOC',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'power', type: 'string', description: 'the power state of the device' },
            { name: 'mode', type: 'number', description: 'the current mode. `1`, normal or fan mode; `2`, auto mode; `3`, sleep mode; `4`, pet mode' },
            { name: 'childLock', type: 'number', description: 'child lock. `0`, disabled; `1`, enabled' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Air Purifier VOC',
        context: {
          deviceType: 'Air Purifier VOC',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'power', type: 'string', description: 'the power state of the device' },
            { name: 'mode', type: 'number', description: 'the current mode. `1`, normal or fan mode; `2`, auto mode; `3`, sleep mode; `4`, pet mode' },
            { name: 'childLock', type: 'number', description: 'child lock. `0`, disabled; `1`, enabled' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Battery Circulator Fan 2 Pro',
        context: {
          deviceType: 'Battery Circulator Fan 2 Pro',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'mode', type: 'string', description: 'fan mode. _direct_, _natural_, _sleep_, or _hurricane_' },
            { name: 'powerState', type: 'string', description: 'ON/OFF state' },
            { name: 'nightStatus', type: 'string', description: 'nightlight state. _on_ or _off_' },
            { name: 'oscillation', type: 'string', description: 'horizontal oscillation. _on_ or _off_' },
            { name: 'verticalOscillation', type: 'string', description: 'vertical oscillation. _on_ or _off_' },
            { name: 'fanSpeed', type: 'number', description: 'fan speed' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Candle Warmer Lamp',
        context: {
          deviceType: 'Candle Warmer Lamp',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'powerState', type: 'string', description: 'ON/OFF state' },
            { name: 'brightness', type: 'number', description: 'attributes of the context object. the brightness value, range from 1 to 100' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Home Climate Panel',
        context: {
          deviceType: 'climate Panel',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'temperature', type: 'number', description: 'the current temperature reading' },
            { name: 'humidity', type: 'number', description: 'the current humidity reading in percentage' },
            { name: 'scale', type: 'string', description: 'the current temperature unit being used' },
            { name: 'battery', type: 'number', description: 'the current battery level' },
            { name: 'detectionState', type: 'string', description: 'the motion state of the device, "DETECTED" stands for motion is detected; "NOT_DETECTED" stands for motion has not been detected for some time' },
            { name: 'brightness', type: 'string', description: 'the brightness level. "bright" or "dim"' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Floor Lamp',
        context: {
          deviceType: 'Floor Lamp',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'powerState', type: 'string', description: 'ON/OFF state' },
            { name: 'brightness', type: 'number', description: 'attributes of the context object. the brightness value, range from 1 to 100' },
            { name: 'colorTemperature', type: 'number', description: 'attributes of the context object. the color temperature value, range from 2700 to 6500' },
            { name: 'color', type: 'string', description: 'the color value, in the format of RGB value, "255:255:255"' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Garage Door Opener',
        context: {
          deviceType: 'Garage Door Opener',
          fields: [
            { name: 'deviceMac', type: 'string', description: 'the MAC address of the device' },
            { name: 'doorStatus', type: 'number', description: 'he switch state of the device. `0`, on; `1`, off' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Evaporative Humidifier (Auto-refill)',
        context: {
          deviceType: 'Humidifier2',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'power', type: 'string', description: 'the power state of the device' },
            { name: 'mode', type: 'number', description: 'the current mode. `1`, level 4; `2`, level 3; `3`, level 2; `4`, level 1; `5`, humidity mode; `6`, sleep mode; `7`, auto mode; `8`, drying mode' },
            { name: 'drying', type: 'boolean', description: 'determines if the device is drying its filter or not' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Keypad Vision',
        context: {
          deviceType: 'Keypad Vision',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'eventName', type: 'string', description: 'attributes of the context object. the name of the command being sent' },
            { name: 'commandId', type: 'string', description: 'attributes of the context object. the command id' },
            { name: 'result', type: 'string', description: 'attributes of the context object. the result of the command. _success_, _failed_, or _timeout_. timeout duration is 1 minute' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Keypad Vision Pro',
        context: {
          deviceType: 'Keypad Vision Pro',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'eventName', type: 'string', description: 'attributes of the context object. the name of the command being sent' },
            { name: 'commandId', type: 'string', description: 'attributes of the context object. the command id' },
            { name: 'result', type: 'string', description: 'attributes of the context object. the result of the command. _success_, _failed_, or _timeout_. timeout duration is 1 minute' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Meter Pro',
        context: {
          deviceType: 'MeterPro',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'temperature', type: 'number', description: 'the current temperature reading' },
            { name: 'scale', type: 'string', description: 'the current temperature unit being used' },
            { name: 'humidity', type: 'number', description: 'the current humidity reading in percentage' },
            { name: 'battery', type: 'number', description: 'the current battery level, `0-100`' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Permanent Outdoor Lights',
        context: {
          deviceType: 'Permanent Outdoor Lights',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'powerState', type: 'string', description: 'ON/OFF state' },
            { name: 'brightness', type: 'number', description: 'the brightness value' },
            { name: 'color', type: 'string', description: 'the color value, RGB `"255:255:255"`' },
            { name: 'colorTemperature', type: 'number', description: 'the color temperature value' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'RGBIC Neon Rope Light',
        context: {
          deviceType: 'RGBIC Neon Rope Light',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'powerState', type: 'string', description: 'attributes of the context object. ON/OFF state' },
            { name: 'brightness', type: 'number', description: 'attributes of the context object. the brightness value, range from 1 to 100' },
            { name: 'color', type: 'string', description: 'the color value, in the format of RGB value, "255:255:255"' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'RGBICWW Ceiling Light',
        context: {
          deviceType: 'RGBICWW Ceiling Light',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'powerState', type: 'string', description: 'main light state. _ON_ or _OFF_' },
            { name: 'brightness', type: 'number', description: 'main light brightness' },
            { name: 'colorTemperature', type: 'number', description: 'main light color temperature' },
            { name: 'colorLightPowerState', type: 'string', description: 'color light state. _ON_ or _OFF_' },
            { name: 'colorLightBrightness', type: 'number', description: 'color light brightness' },
            { name: 'colorLightColor', type: 'string', description: 'color light RGB value' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'RGBICWW Floor Lamp',
        context: {
          deviceType: 'RGBICWW Floor Lamp',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'powerState', type: 'string', description: 'attributes of the context object. ON/OFF state' },
            { name: 'brightness', type: 'number', description: 'attributes of the context object. the brightness value, range from 1 to 100' },
            { name: 'color', type: 'string', description: 'the color value, in the format of RGB value, "255:255:255"' },
            { name: 'colorTemperature', type: 'number', description: 'attributes of the context object. the color temperature value, range from 2700 to 6500' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'RGBICWW Strip Light',
        context: {
          deviceType: 'RGBICWW Strip Light',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'powerState', type: 'string', description: 'attributes of the context object. ON/OFF state' },
            { name: 'brightness', type: 'number', description: 'attributes of the context object. the brightness value, range from 1 to 100' },
            { name: 'color', type: 'string', description: 'the color value, in the format of RGB value, "255:255:255"' },
            { name: 'colorTemperature', type: 'number', description: 'attributes of the context object. the color temperature value, range from 2700 to 6500' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'K10+ Pro Combo',
        context: {
          deviceType: 'Robot Vacuum Cleaner K10+ Pro Combo',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'workingStatus', type: 'string', description: 'attributes of the context object. the working status of the device. _StandBy_, _Clearing_, _Paused_, _GotoChargeBase_, _Charging_, _ChargeDone_, _Dormant_, _InTrouble_, _InRemoteControl_, or _InDustCollecting_' },
            { name: 'onlineStatus', type: 'string', description: 'attributes of the context object. the connection status of the device. _online_ or _offline_' },
            { name: 'battery', type: 'number', description: 'attributes of the context object. the battery level, range from 0 to 100' },
            { name: 'taskType', type: 'string', description: 'attributes of the context object. the current task in progress. _standBy_, _explore_, _cleanAll_, _cleanArea_, _cleanRoom_, _backToCharge_, _collectDust_, _remoteControl_, _cleanWithExplorer_' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Robot Vacuum K11+',
        context: {
          deviceType: 'Robot Vacuum Cleaner K11 Plus',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'workingStatus', type: 'string', description: 'attributes of the context object. the working status of the device. _StandBy_, _Clearing_, _Paused_, _GotoChargeBase_, _Charging_, _ChargeDone_, _Dormant_, _InTrouble_, _InRemoteControl_, or _InDustCollecting_' },
            { name: 'onlineStatus', type: 'string', description: 'attributes of the context object. the connection status of the device. _online_ or _offline_' },
            { name: 'battery', type: 'number', description: 'attributes of the context object. the battery level, range from 0 to 100' },
            { name: 'taskType', type: 'string', description: 'the current task in progress. _standBy_, _explore_, _cleanAll_, _cleanArea_, _cleanRoom_, _fillWater_, _deepWashing_, _backToCharge_, _markingWaterBase_, _drying_, _collectDust_, _remoteControl_, _cleanWithExplorer_, _fillWaterForHumi_, _markingHumi_' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'K20+ Pro',
        context: {
          deviceType: 'Robot Vacuum Cleaner K20+ Pro',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'workingStatus', type: 'string', description: 'attributes of the context object. the working status of the device. _StandBy_, _Clearing_, _Paused_, _GotoChargeBase_, _Charging_, _ChargeDone_, _Dormant_, _InTrouble_, _InRemoteControl_, or _InDustCollecting_' },
            { name: 'onlineStatus', type: 'string', description: 'attributes of the context object. the connection status of the device. _online_ or _offline_' },
            { name: 'battery', type: 'number', description: 'attributes of the context object. the battery level, range from 0 to 100' },
            { name: 'taskType', type: 'string', description: 'attributes of the context object. the current task in progress. _standBy_, _explore_, _cleanAll_, _cleanArea_, _cleanRoom_, _backToCharge_, _collectDust_, _remoteControl_, _cleanWithExplorer_' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Floor Cleaning Robot S20',
        context: {
          deviceType: 'Robot Vacuum Cleaner s20',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'workingStatus', type: 'string', description: 'attributes of the context object. the working status of the device. _StandBy_, _Clearing_, _Paused_, _GotoChargeBase_, _Charging_, _ChargeDone_, _Dormant_, _InTrouble_, _InRemoteControl_, or _InDustCollecting_' },
            { name: 'onlineStatus', type: 'string', description: 'attributes of the context object. the connection status of the device. _online_ or _offline_' },
            { name: 'battery', type: 'number', description: 'attributes of the context object. the battery level, `0-100`' },
            { name: 'waterBaseBattery', type: 'number', description: 'the current battery level `0-100`' },
            { name: 'taskType', type: 'string', description: 'the current task in progress. _standBy_, _explore_, _cleanAll_, _cleanArea_, _cleanRoom_, _fillWater_, _deepWashing_, _backToCharge_, _markingWaterBase_, _drying_, _collectDust_, _remoteControl_, _cleanWithExplorer_, _fillWaterForHumi_, _markingHumi_' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Lock Ultra',
        context: {
          deviceType: 'Smart Lock Ultra',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'lockState', type: 'string', description: 'the state of the device, "LOCKED" stands for the motor is rotated to locking position; "UNLOCKED" stands for the motor is rotated to unlocking position; "JAMMED" stands for the motor is jammed while rotating' },
            { name: 'battery', type: 'number', description: 'the battery level' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Smart Radiator Thermostat',
        context: {
          deviceType: 'Smart Radiator Thermostat',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'mode', type: 'string', description: 'Current mode. The upstream table says String but its example uses 1; this advisory type does not coerce payloads.' },
            { name: 'battery', type: 'number', description: 'the battery level' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Standing Circulator Fan',
        context: {
          deviceType: 'Standing Fan',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'mode', type: 'string', description: 'fan mode. direct mode: _direct_; natural mode: "natural"; sleep mode: "sleep"; ultra quiet mode: "baby"' },
            { name: 'version', type: 'string', description: 'the current firmware version, e.g. V4.2' },
            { name: 'powerState', type: 'string', description: 'ON/OFF state' },
            { name: 'nightStatus', type: 'string', description: 'set nightlight status. turn off: _off_; mode 1: _1_; mode 2: _2_' },
            { name: 'oscillation', type: 'string', description: 'set horizontal oscillation. turn on: _on_; turn off: _off_' },
            { name: 'verticalOscillation', type: 'string', description: 'set vertical oscillation. turn on: _on_; turn off: _off_' },
            { name: 'fanSpeed', type: 'number', description: 'fan speed. 1~100' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Strip Light 3',
        context: {
          deviceType: 'Strip Light 3',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'powerState', type: 'string', description: 'ON/OFF state' },
            { name: 'brightness', type: 'number', description: 'attributes of the context object. the brightness value, range from 1 to 100' },
            { name: 'colorTemperature', type: 'number', description: 'attributes of the context object. the color temperature value, range from 2700 to 6500' },
            { name: 'color', type: 'string', description: 'the color value, in the format of RGB value, "255:255:255"' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Lock Vision',
        context: {
          deviceType: 'W1141000',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'lockState', type: 'string', description: 'the state of the device, "LOCKED" stands for the motor is rotated to locking position; "UNLOCKED" stands for the motor is rotated to unlocking position; "JAMMED" stands for the motor is jammed while rotating' },
            { name: 'battery', type: 'number', description: 'the battery level' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Lock Vision Pro',
        context: {
          deviceType: 'W1141001',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'lockState', type: 'string', description: 'the state of the device, "LOCKED" stands for the motor is rotated to locking position; "UNLOCKED" stands for the motor is rotated to unlocking position; "JAMMED" stands for the motor is jammed while rotating' },
            { name: 'battery', type: 'number', description: 'the battery level' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Weather Station',
        context: {
          deviceType: 'WeatherStation',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'temperature', type: 'number', description: 'the current temperature reading' },
            { name: 'scale', type: 'string', description: 'the current temperature unit being used' },
            { name: 'humidity', type: 'number', description: 'the current humidity reading in percentage' },
            { name: 'battery', type: 'number', description: 'the current battery level, `0-100`' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Indoor Cam',
        context: {
          deviceType: 'WoCamera',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'detectionState', type: 'string', description: 'the detection state of the device, "DETECTED" stands for motion is detected' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Ceiling Light',
        context: {
          deviceType: 'WoCeiling',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'powerState', type: 'string', description: 'attributes of the context object. ON/OFF state' },
            { name: 'brightness', type: 'number', description: 'attributes of the context object. the brightness value, range from 1 to 100' },
            { name: 'colorTemperature', type: 'number', description: 'attributes of the context object. the color temperature value, range from 2700 to 6500' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Ceiling Light Pro',
        context: {
          deviceType: 'WoCeilingPro',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'powerState', type: 'string', description: 'attributes of the context object. ON/OFF state' },
            { name: 'brightness', type: 'number', description: 'attributes of the context object. the brightness value, range from 1 to 100' },
            { name: 'colorTemperature', type: 'number', description: 'attributes of the context object. the color temperature value, range from 2700 to 6500' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Curtain 3',
        context: {
          deviceType: 'WoCurtain3',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'calibrate', type: 'boolean', description: 'determines if the open position and the close position of a device have been properly calibrated or not' },
            { name: 'group', type: 'boolean', description: 'determines if a Curtain is paired with or grouped with another Curtain or not' },
            { name: 'slidePosition', type: 'number', description: 'the percentage of the distance between the calibrated open position and closed position that Curtain has traversed' },
            { name: 'battery', type: 'number', description: 'the battery level of a Curtain' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Battery Circulator Fan',
        context: {
          deviceType: 'WoFan2',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'mode', type: 'string', description: 'fan mode. direct mode: _direct_; natural mode: "natural"; sleep mode: "sleep"; ultra quiet mode: "baby"' },
            { name: 'version', type: 'string', description: 'the current firmware version, e.g. V4.2' },
            { name: 'battery', type: 'number', description: 'the current battery level' },
            { name: 'powerState', type: 'string', description: 'ON/OFF state' },
            { name: 'nightStatus', type: 'number', description: 'Nightlight state. The upstream table says Integer but its example uses "off"; raw off/1/2 values are not coerced.' },
            { name: 'oscillation', type: 'string', description: 'set horizontal oscillation. turn on: _on_; turn off: _off_' },
            { name: 'verticalOscillation', type: 'string', description: 'set vertical oscillation. turn on: _on_; turn off: _off_' },
            { name: 'chargingStatus', type: 'string', description: 'battery charge status. _charging_ or _uncharged_' },
            { name: 'fanSpeed', type: 'number', description: 'fan speed. 1~100' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Outdoor Meter',
        context: {
          deviceType: 'WoIOSensor',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'temperature', type: 'number', description: 'the current temperature reading' },
            { name: 'scale', type: 'string', description: 'the current temperature unit being used' },
            { name: 'humidity', type: 'number', description: 'the current humidity reading in percentage' },
            { name: 'battery', type: 'number', description: 'the current battery level, `0-100`' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Keypad Touch',
        context: {
          deviceType: 'WoKeypadTouch',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'eventName', type: 'string', description: 'attributes of the context object. the name of the command being sent' },
            { name: 'commandId', type: 'string', description: 'attributes of the context object. the command id' },
            { name: 'result', type: 'string', description: 'attributes of the context object. the result of the command. _success_, _failed_, or _timeout_. timeout duration is 1 minute' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Lock Lite',
        context: {
          deviceType: 'WoLockLite',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'lockState', type: 'string', description: 'determines if locked or not' },
            { name: 'battery', type: 'number', description: 'the battery level' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Lock Pro',
        context: {
          deviceType: 'WoLockPro',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'lockState', type: 'string', description: 'the state of the device, "LOCKED" stands for the motor is rotated to locking position; "UNLOCKED" stands for the motor is rotated to unlocking position; "JAMMED" stands for the motor is jammed while rotating' },
            { name: 'battery', type: 'number', description: 'the current battery level, `0-100`' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Lock Pro Matter Enabled',
        context: {
          deviceType: 'WoLockProWifi',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'lockState', type: 'string', description: 'the state of the device, "LOCKED" stands for the motor is rotated to locking position; "UNLOCKED" stands for the motor is rotated to unlocking position; "JAMMED" stands for the motor is jammed while rotating' },
            { name: 'battery', type: 'number', description: 'the current battery level, `0-100`' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Pan/Tilt Cam',
        context: {
          deviceType: 'WoPanTiltCam',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'detectionState', type: 'string', description: 'the detection state of the device, "DETECTED" stands for motion is detected' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Robot Vacuum Cleaner S1',
        context: {
          deviceType: 'WoSweeper',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'workingStatus', type: 'string', description: 'attributes of the context object. the working status of the device. _StandBy_, _Clearing_, _Paused_, _GotoChargeBase_, _Charging_, _ChargeDone_, _Dormant_, _InTrouble_, _InRemoteControl_, or _InDustCollecting_' },
            { name: 'onlineStatus', type: 'string', description: 'attributes of the context object. the connection status of the device. _online_ or _offline_' },
            { name: 'battery', type: 'number', description: 'attributes of the context object. the battery level, range from 0 to 100' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Mini Robot Vacuum K10+',
        context: {
          deviceType: 'WoSweeperMini',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'workingStatus', type: 'string', description: 'attributes of the context object. the working status of the device. _StandBy_, _Clearing_, _Paused_, _GotoChargeBase_, _Charging_, _ChargeDone_, _Dormant_, _InTrouble_, _InRemoteControl_, or _InDustCollecting_' },
            { name: 'onlineStatus', type: 'string', description: 'attributes of the context object. the connection status of the device. _online_ or _offline_' },
            { name: 'battery', type: 'number', description: 'attributes of the context object. the battery level, range from 0 to 100' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Mini Robot Vacuum K10+ Pro',
        context: {
          deviceType: 'WoSweeperMiniPro',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'workingStatus', type: 'string', description: 'attributes of the context object. the working status of the device. _StandBy_, _Clearing_, _Paused_, _GotoChargeBase_, _Charging_, _ChargeDone_, _Dormant_, _InTrouble_, _InRemoteControl_, or _InDustCollecting_' },
            { name: 'onlineStatus', type: 'string', description: 'attributes of the context object. the connection status of the device. _online_ or _offline_' },
            { name: 'battery', type: 'number', description: 'attributes of the context object. the battery level, range from 0 to 100' },
          ],
        },
      },
      {
        eventType: 'changeReport',
        eventVersion: '1',
        devicePattern: 'Robot Vacuum Cleaner S1 Plus',
        context: {
          deviceType: 'WoSweeperPlus',
          fields: [
            ...COMMON_WEBHOOK_CONTEXT_FIELDS,
            { name: 'workingStatus', type: 'string', description: 'attributes of the context object. the working status of the device. _StandBy_, _Clearing_, _Paused_, _GotoChargeBase_, _Charging_, _ChargeDone_, _Dormant_, _InTrouble_, _InRemoteControl_, or _InDustCollecting_' },
            { name: 'onlineStatus', type: 'string', description: 'attributes of the context object. the connection status of the device. _online_ or _offline_' },
            { name: 'battery', type: 'number', description: 'attributes of the context object. the battery level, range from 0 to 100' },
          ],
        },
      },
    ],
  },

  keys: [
    {
      keyType: 'permanent',
      description: 'Passcode that never expires — valid until manually deleted.',
      requiredParams: ['name', 'password'],
      optionalParams: [],
      supportedDevices: ['Keypad', 'Keypad Touch', 'Keypad Vision', 'Keypad Vision Pro'],
      safetyTier: 'destructive',
    },
    {
      keyType: 'timeLimit',
      description: 'Passcode valid only between startTime and endTime (Unix seconds).',
      requiredParams: ['name', 'password', 'startTime', 'endTime'],
      optionalParams: [],
      supportedDevices: ['Keypad', 'Keypad Touch', 'Keypad Vision', 'Keypad Vision Pro'],
      safetyTier: 'destructive',
    },
    {
      keyType: 'disposable',
      description: 'Single-use passcode valid between startTime and endTime (10-digit Unix seconds).',
      requiredParams: ['name', 'password', 'startTime', 'endTime'],
      optionalParams: [],
      supportedDevices: ['Keypad', 'Keypad Touch', 'Keypad Vision', 'Keypad Vision Pro'],
      safetyTier: 'destructive',
    },
    {
      keyType: 'urgent',
      description: 'Emergency passcode (typically tied to panic / audit workflow).',
      requiredParams: ['name', 'password'],
      optionalParams: [],
      supportedDevices: ['Keypad', 'Keypad Touch', 'Keypad Vision', 'Keypad Vision Pro'],
      safetyTier: 'destructive',
    },
  ],
};

/** Convenience: return the documented webhook context device types. */
export function listWebhookContextDeviceTypes(): string[] {
  return RESOURCE_CATALOG.webhooks.events.map((e) => e.context.deviceType);
}

/** Convenience: return the list of supported keypad key types. */
export function listKeyTypes(): string[] {
  return RESOURCE_CATALOG.keys.map((k) => k.keyType);
}
