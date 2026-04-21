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
 * - Webhook event list is derived from the device catalog and is advisory —
 *   not every SwitchBot device actually pushes every listed event; refer to
 *   the SwitchBot webhook docs for authoritative shapes.
 */

export type ResourceSafetyTier = 'read' | 'mutation' | 'destructive';

export interface SceneOperation {
  verb: 'list' | 'execute' | 'describe';
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

export interface WebhookEventField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'timestamp';
  description: string;
  example?: unknown;
}

export interface WebhookEventSpec {
  eventType: string;
  devicePattern: string;
  fields: ReadonlyArray<WebhookEventField>;
}

export interface WebhookCatalog {
  endpoints: ReadonlyArray<WebhookEndpoint>;
  events: ReadonlyArray<WebhookEventSpec>;
  constraints: {
    maxUrlLength: number;
    maxWebhooksPerAccount: number;
  };
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
  scenes: SceneSpec;
  webhooks: WebhookCatalog;
  keys: ReadonlyArray<KeySpec>;
}

const COMMON_WEBHOOK_FIELDS: ReadonlyArray<WebhookEventField> = [
  { name: 'deviceType', type: 'string', description: 'SwitchBot device type string', example: 'WoMeter' },
  { name: 'deviceMac', type: 'string', description: 'Bluetooth MAC address (uppercase, colon-separated)', example: 'AA:BB:CC:11:22:33' },
  { name: 'timeOfSample', type: 'timestamp', description: 'Millisecond Unix timestamp when the sample was taken', example: 1700000000000 },
];

export const RESOURCE_CATALOG: ResourceCatalog = {
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
      {
        verb: 'describe',
        method: 'GET',
        endpoint: '/v1.1/scenes/{sceneId}',
        params: [{ name: 'sceneId', required: true, type: 'string' }],
        safetyTier: 'read',
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
        eventType: 'WoMeter',
        devicePattern: 'Meter / Meter Plus / Indoor-Outdoor Meter',
        fields: [
          ...COMMON_WEBHOOK_FIELDS,
          { name: 'temperature', type: 'number', description: 'Ambient temperature in Celsius', example: 22.5 },
          { name: 'humidity', type: 'number', description: 'Relative humidity (%)', example: 45 },
          { name: 'battery', type: 'number', description: 'Battery remaining (%)', example: 88 },
        ],
      },
      {
        eventType: 'WoCO2Sensor',
        devicePattern: 'CO2 Monitor',
        fields: [
          ...COMMON_WEBHOOK_FIELDS,
          { name: 'CO2', type: 'number', description: 'CO2 concentration in ppm', example: 520 },
          { name: 'temperature', type: 'number', description: 'Ambient temperature in Celsius' },
          { name: 'humidity', type: 'number', description: 'Relative humidity (%)' },
        ],
      },
      {
        eventType: 'WoPresence',
        devicePattern: 'Motion Sensor / Video Doorbell motion',
        fields: [
          ...COMMON_WEBHOOK_FIELDS,
          { name: 'detectionState', type: 'string', description: 'Detection result word', example: 'DETECTED' },
        ],
      },
      {
        eventType: 'WoContact',
        devicePattern: 'Contact Sensor',
        fields: [
          ...COMMON_WEBHOOK_FIELDS,
          { name: 'openState', type: 'string', description: 'Door/window state', example: 'open' },
          { name: 'moveDetected', type: 'boolean', description: 'Motion detected during this sample' },
        ],
      },
      {
        eventType: 'WoLock',
        devicePattern: 'Smart Lock / Smart Lock Lite / Smart Lock Pro',
        fields: [
          ...COMMON_WEBHOOK_FIELDS,
          { name: 'lockState', type: 'string', description: 'Lock state: locked, unlocked, jammed', example: 'locked' },
          { name: 'battery', type: 'number', description: 'Battery remaining (%)' },
        ],
      },
      {
        eventType: 'WoPlug',
        devicePattern: 'Plug Mini / Plug / Relay Switch',
        fields: [
          ...COMMON_WEBHOOK_FIELDS,
          { name: 'power', type: 'string', description: 'Power state (on/off)', example: 'on' },
          { name: 'voltage', type: 'number', description: 'Instantaneous voltage (V)' },
          { name: 'electricCurrent', type: 'number', description: 'Instantaneous current (A)' },
        ],
      },
      {
        eventType: 'WoBot',
        devicePattern: 'Bot',
        fields: [
          ...COMMON_WEBHOOK_FIELDS,
          { name: 'power', type: 'string', description: 'Power state (on/off)' },
          { name: 'battery', type: 'number', description: 'Battery remaining (%)' },
        ],
      },
      {
        eventType: 'WoCurtain',
        devicePattern: 'Curtain / Blind Tilt / Roller Shade',
        fields: [
          ...COMMON_WEBHOOK_FIELDS,
          { name: 'slidePosition', type: 'number', description: 'Current slide position (0–100)' },
          { name: 'calibrate', type: 'boolean', description: 'True if device is calibrated' },
        ],
      },
      {
        eventType: 'WoDoorbell',
        devicePattern: 'Video Doorbell button press',
        fields: [
          ...COMMON_WEBHOOK_FIELDS,
          { name: 'buttonName', type: 'string', description: 'Identifier of the pressed button' },
          { name: 'pressedAt', type: 'timestamp', description: 'Press timestamp in milliseconds' },
        ],
      },
      {
        eventType: 'WoKeypad',
        devicePattern: 'Keypad scan / createKey result / deleteKey result',
        fields: [
          ...COMMON_WEBHOOK_FIELDS,
          { name: 'eventType', type: 'string', description: 'Sub-event (createKey / deleteKey / invalidCode)' },
          { name: 'commandId', type: 'string', description: 'Correlation id returned by the original command' },
          { name: 'result', type: 'string', description: 'Outcome (success / failed / timeout)' },
        ],
      },
      {
        eventType: 'WoColorBulb',
        devicePattern: 'Color Bulb',
        fields: [
          ...COMMON_WEBHOOK_FIELDS,
          { name: 'power', type: 'string', description: 'Power state (on/off)' },
          { name: 'brightness', type: 'number', description: 'Brightness (0–100)' },
          { name: 'color', type: 'string', description: 'RGB triplet "r:g:b"' },
          { name: 'colorTemperature', type: 'number', description: 'Color temperature in Kelvin' },
        ],
      },
      {
        eventType: 'WoStrip',
        devicePattern: 'Strip Light',
        fields: [
          ...COMMON_WEBHOOK_FIELDS,
          { name: 'power', type: 'string', description: 'Power state (on/off)' },
          { name: 'brightness', type: 'number', description: 'Brightness (0–100)' },
          { name: 'color', type: 'string', description: 'RGB triplet "r:g:b"' },
        ],
      },
      {
        eventType: 'WoSweeper',
        devicePattern: 'Robot Vacuum',
        fields: [
          ...COMMON_WEBHOOK_FIELDS,
          { name: 'workingStatus', type: 'string', description: 'Cleaning state' },
          { name: 'battery', type: 'number', description: 'Battery remaining (%)' },
          { name: 'taskType', type: 'string', description: 'Current task (standby / clean / charge)' },
        ],
      },
      {
        eventType: 'WoWaterLeakDetect',
        devicePattern: 'Water Leak Detector',
        fields: [
          ...COMMON_WEBHOOK_FIELDS,
          { name: 'waterLeakDetect', type: 'number', description: 'Leak flag (0 = dry, 1 = leak detected)' },
          { name: 'battery', type: 'number', description: 'Battery remaining (%)' },
        ],
      },
      {
        eventType: 'WoHub',
        devicePattern: 'Hub 2 / Hub 3 (ambient sensors)',
        fields: [
          ...COMMON_WEBHOOK_FIELDS,
          { name: 'temperature', type: 'number', description: 'Ambient temperature in Celsius' },
          { name: 'humidity', type: 'number', description: 'Relative humidity (%)' },
          { name: 'lightLevel', type: 'number', description: 'Illuminance level' },
        ],
      },
    ],
    constraints: {
      maxUrlLength: 2048,
      maxWebhooksPerAccount: 1,
    },
  },

  keys: [
    {
      keyType: 'permanent',
      description: 'Passcode that never expires — valid until manually deleted.',
      requiredParams: ['name', 'password'],
      optionalParams: [],
      supportedDevices: ['Keypad', 'Keypad Touch'],
      safetyTier: 'destructive',
    },
    {
      keyType: 'timeLimit',
      description: 'Passcode valid only between startTime and endTime (Unix seconds).',
      requiredParams: ['name', 'password', 'startTime', 'endTime'],
      optionalParams: [],
      supportedDevices: ['Keypad', 'Keypad Touch'],
      safetyTier: 'destructive',
    },
    {
      keyType: 'disposable',
      description: 'Passcode that can be used once and then auto-expires.',
      requiredParams: ['name', 'password'],
      optionalParams: ['startTime', 'endTime'],
      supportedDevices: ['Keypad', 'Keypad Touch'],
      safetyTier: 'destructive',
    },
    {
      keyType: 'urgent',
      description: 'Emergency passcode (typically tied to panic / audit workflow).',
      requiredParams: ['name', 'password'],
      optionalParams: [],
      supportedDevices: ['Keypad', 'Keypad Touch'],
      safetyTier: 'destructive',
    },
  ],
};

/** Convenience: return the list of known webhook event types. */
export function listWebhookEventTypes(): string[] {
  return RESOURCE_CATALOG.webhooks.events.map((e) => e.eventType);
}

/** Convenience: return the list of supported keypad key types. */
export function listKeyTypes(): string[] {
  return RESOURCE_CATALOG.keys.map((k) => k.keyType);
}
