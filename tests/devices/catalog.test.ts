import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DEVICE_CATALOG,
  findCatalogEntry,
  suggestedActions,
  deriveSafetyTier,
  getCommandSafetyReason,
  type SafetyTier,
} from '../../src/devices/catalog.js';

// Snapshot from OpenWonderLabs/SwitchBotAPI README.md:
// "device type. *...*" fields in the device list / status sections.
// Keep this list in sync when upstream documents new API deviceType strings.
const OFFICIAL_API_DEVICE_TYPES = [
  'AI Art Frame',
  'AI Hub',
  'AI MindClip',
  'Air Purifier PM2.5',
  'Air Purifier Table PM2.5',
  'Air Purifier Table VOC',
  'Air Purifier VOC',
  'Battery Circulator Fan',
  'Battery Circulator Fan 2 Pro',
  'Blind Tilt',
  'Bot',
  'Candle Warmer Lamp',
  'Ceiling Light',
  'Ceiling Light Pro',
  'Circulator Fan',
  'Color Bulb',
  'Contact Sensor',
  'Curtain',
  'Curtain3',
  'Floor Lamp',
  'Garage Door Opener',
  'Home Climate Panel',
  'Hub',
  'Hub 2',
  'Hub 3',
  'Hub Mini',
  'Hub Plus',
  'Humidifier',
  'Humidifier2',
  'Indoor Cam',
  'K10+',
  'K10+ Pro',
  'Kata Friends',
  'Keypad',
  'Keypad Touch',
  'Keypad Vision',
  'Keypad Vision Pro',
  'Lock Lite',
  'Lock Ultra',
  'Lock Vision',
  'Lock Vision Pro',
  'Meter',
  'MeterPlus',
  'MeterPro',
  'MeterPro(CO2)',
  'Motion Sensor',
  'Pan/Tilt Cam',
  'Pan/Tilt Cam 2K',
  'Pan/Tilt Cam Plus 2K',
  'Pan/Tilt Cam Plus 3K',
  'Permanent Outdoor Lights',
  'Plug',
  'Plug Mini (EU)',
  'Plug Mini (JP)',
  'Plug Mini (US)',
  'Presence Sensor',
  'RGBIC Neon Rope Light',
  'RGBIC Neon Wire Rope Light',
  'RGBICWW Ceiling Light',
  'RGBICWW Floor Lamp',
  'RGBICWW Strip Light',
  'Relay Switch 1',
  'Relay Switch 1PM',
  'Relay Switch 2PM',
  'Remote',
  'Robot Vacuum Cleaner K10+ Pro Combo',
  'Robot Vacuum Cleaner K11+',
  'Robot Vacuum Cleaner K20 Plus Pro',
  'Robot Vacuum Cleaner S1',
  'Robot Vacuum Cleaner S1 Plus',
  'Robot Vacuum Cleaner S10',
  'Robot Vacuum Cleaner S20',
  'Roller Shade',
  'Smart Lock',
  'Smart Lock Pro',
  'Smart Lock Pro Wifi',
  'Smart Lock Ultra',
  'Smart Radiator Thermostat',
  'Standing Circulator Fan',
  'Strip Light',
  'Strip Light 3',
  'Video Doorbell',
  'Water Detector',
  'WeatherStation',
  'WoIOSensor',
] as const;

// Snapshot from the same README's "Supported Device List" table. Some names
// are product-table aliases rather than raw API deviceType strings.
const OFFICIAL_SUPPORTED_DEVICE_LIST_NAMES = [
  'Hub Mini',
  'Hub Plus',
  'Hub 2',
  'Hub 3',
  'Bot',
  'Curtain',
  'Curtain 3',
  'Plug',
  'Meter',
  'Meter Plus (JP)',
  'Meter Plus (US)',
  'Outdoor Meter',
  'Meter Pro',
  'Meter Pro (CO2 Monitor)',
  'Motion Sensor',
  'Contact Sensor',
  'Prensence Sensor',
  'Water Leak Detector',
  'Color Bulb',
  'Strip Light',
  'Plug Mini (US)',
  'Plug Mini (JP)',
  'Plug Mini (EU)',
  'Lock',
  'Lock Pro',
  'Keypad',
  'Keypad Touch',
  'S1',
  'S1 Plus',
  'K10+',
  'K10+ Pro',
  'S10',
  'S20',
  'K10+ Pro Combo',
  'K20+ Pro',
  'Ceiling Light',
  'Ceiling Light Pro',
  'RGBICWW Strip Light',
  'RGBICWW Floor Lamp',
  'RGBIC Neon Rope Light',
  'RGBIC Neon Wire Rope Light',
  'Indoor Cam',
  'Pan/Tilt Cam',
  'Pan/Tilt Cam 2K',
  'Blind Tilt',
  'Battery Circulator Fan',
  'Circulator Fan',
  'Evaporative Humidifier',
  'Evaporative Humidifier (Auto-refill)',
  'Air Purifier PM2.5',
  'Air Purifier Table PM2.5',
  'Air Purifier VOC',
  'Air Purifier Table VOC',
  'Roller Shade',
  'Relay Switch 1PM',
  'Relay Switch 1',
  'Relay Switch 2PM',
  'Garage Door Opener',
  'Floor Lamp',
  'Strip Light 3',
  'Lock Lite',
  'Video Doorbell',
  'Keypad Vision',
  'Keypad Vision Pro',
  'Lock Ultra',
  'Standing Circulator Fan',
  'Pan/Tilt Cam Plus 2K',
  'Pan/Tilt Cam Plus 3K',
  'AI Hub',
  'Candle Warmer Lamp',
  'Home Climate Panel',
  'Smart Radiator Thermostat',
  'AI Art Frame',
] as const;

describe('devices/catalog', () => {
  describe('schema integrity', () => {
    it('every entry has a type, category, and commands array', () => {
      for (const entry of DEVICE_CATALOG) {
        expect(entry.type).toBeTypeOf('string');
        expect(['physical', 'ir']).toContain(entry.category);
        expect(Array.isArray(entry.commands)).toBe(true);
      }
    });

    it('every entry has a role assigned', () => {
      for (const entry of DEVICE_CATALOG) {
        expect(
          entry.role,
          `${entry.type} is missing a role — new entries must be categorized`
        ).toBeTypeOf('string');
      }
    });

    it('status-only entries (no commands) are marked readOnly', () => {
      for (const entry of DEVICE_CATALOG) {
        if (entry.commands.length === 0 && entry.type !== 'Others') {
          expect(entry.readOnly, `${entry.type} has no commands but is not readOnly`).toBe(true);
        }
      }
    });

    it('has no duplicate type names', () => {
      const types = DEVICE_CATALOG.map((e) => e.type);
      const unique = new Set(types);
      expect(types.length).toBe(unique.size);
    });

    it('every entry has a description string', () => {
      for (const entry of DEVICE_CATALOG) {
        expect(entry.description, `${entry.type} is missing description`).toBeTypeOf('string');
        expect((entry.description as string).length, `${entry.type} description is empty`).toBeGreaterThan(0);
      }
    });

    it('every destructive command has a safetyReason (or legacy destructiveReason)', () => {
      for (const entry of DEVICE_CATALOG) {
        for (const cmd of entry.commands) {
          if (deriveSafetyTier(cmd, entry) === 'destructive') {
            const reason = getCommandSafetyReason(cmd);
            expect(
              reason,
              `${entry.type}.${cmd.command} is destructive but missing safetyReason/destructiveReason`,
            ).toBeTypeOf('string');
          }
        }
      }
    });

    it('resolves every official GitHub-documented API deviceType', () => {
      for (const type of OFFICIAL_API_DEVICE_TYPES) {
        const match = findCatalogEntry(type);
        expect(match, `${type} is missing from catalog type/aliases`).not.toBeNull();
        expect(Array.isArray(match), `${type} should resolve to one catalog entry`).toBe(false);
      }
    });

    it('resolves every official GitHub Supported Device List name', () => {
      for (const type of OFFICIAL_SUPPORTED_DEVICE_LIST_NAMES) {
        const match = findCatalogEntry(type);
        expect(match, `${type} is missing from catalog type/aliases`).not.toBeNull();
        expect(Array.isArray(match), `${type} should resolve to one catalog entry`).toBe(false);
      }
    });
  });

  describe('command annotations', () => {
    const commandOf = (type: string, cmd: string) => {
      const entry = DEVICE_CATALOG.find((e) => e.type === type);
      return entry?.commands.find((c) => c.command === cmd);
    };

    const tierOf = (type: string, cmd: string): SafetyTier | undefined => {
      const entry = DEVICE_CATALOG.find((e) => e.type === type);
      const spec = entry?.commands.find((c) => c.command === cmd);
      return entry && spec ? deriveSafetyTier(spec, entry) : undefined;
    };

    it('turnOn / turnOff are idempotent across every device type', () => {
      for (const entry of DEVICE_CATALOG) {
        for (const c of entry.commands) {
          if (c.command === 'turnOn' || c.command === 'turnOff') {
            expect(
              c.idempotent,
              `${entry.type}.${c.command} should be idempotent`
            ).toBe(true);
          }
        }
      }
    });

    it('toggle / press / volumeAdd are never idempotent', () => {
      const volatileCommands = new Set(['toggle', 'press', 'volumeAdd', 'volumeSub', 'channelAdd', 'channelSub', 'brightnessUp', 'brightnessDown']);
      for (const entry of DEVICE_CATALOG) {
        for (const c of entry.commands) {
          if (volatileCommands.has(c.command)) {
            expect(
              c.idempotent,
              `${entry.type}.${c.command} should not be idempotent`
            ).toBe(false);
          }
        }
      }
    });

    it('Smart Lock unlock is safetyTier: destructive', () => {
      expect(tierOf('Smart Lock', 'unlock')).toBe('destructive');
      expect(tierOf('Smart Lock Lite', 'unlock')).toBe('destructive');
      expect(tierOf('Smart Lock Ultra', 'unlock')).toBe('destructive');
    });

    it('Garage Door Opener turnOn and turnOff are safetyTier: destructive', () => {
      expect(tierOf('Garage Door Opener', 'turnOn')).toBe('destructive');
      expect(tierOf('Garage Door Opener', 'turnOff')).toBe('destructive');
    });

    it('Keypad createKey/deleteKey are safetyTier: destructive', () => {
      expect(tierOf('Keypad', 'createKey')).toBe('destructive');
      expect(tierOf('Keypad', 'deleteKey')).toBe('destructive');
    });

    it('Smart Lock `lock` is mutation, not destructive', () => {
      expect(tierOf('Smart Lock', 'lock')).toBe('mutation');
      expect(commandOf('Smart Lock', 'lock')?.safetyTier).toBeUndefined();
    });

    it('setBrightness / setColor / setColorTemperature carry exampleParams', () => {
      for (const entry of DEVICE_CATALOG) {
        for (const c of entry.commands) {
          if (['setBrightness', 'setColor', 'setColorTemperature'].includes(c.command)) {
            expect(
              c.exampleParams?.length,
              `${entry.type}.${c.command} should have exampleParams`
            ).toBeGreaterThan(0);
          }
        }
      }
    });

    it('every command resolves to one of the 5 safety tiers', () => {
      const allowed: SafetyTier[] = ['read', 'mutation', 'ir-fire-forget', 'destructive', 'maintenance'];
      for (const entry of DEVICE_CATALOG) {
        for (const c of entry.commands) {
          const tier = deriveSafetyTier(c, entry);
          expect(
            allowed.includes(tier),
            `${entry.type}.${c.command} derived to unknown tier "${tier}"`,
          ).toBe(true);
        }
      }
    });

    it('every IR entry has ir-fire-forget as its default tier', () => {
      for (const entry of DEVICE_CATALOG) {
        if (entry.category !== 'ir') continue;
        for (const c of entry.commands) {
          expect(
            deriveSafetyTier(c, entry),
            `${entry.type}.${c.command} in IR category should be ir-fire-forget`,
          ).toBe('ir-fire-forget');
        }
      }
    });

    it('no built-in entry uses "read" or "maintenance" tier today (reserved)', () => {
      for (const entry of DEVICE_CATALOG) {
        for (const c of entry.commands) {
          const tier = deriveSafetyTier(c, entry);
          expect(tier).not.toBe('read');
          expect(tier).not.toBe('maintenance');
        }
      }
    });

    it('deriveSafetyTier uses safetyTier field directly', () => {
      expect(deriveSafetyTier({ command: 'x', parameter: '-', description: '', safetyTier: 'destructive' }))
        .toBe('destructive');
    });

    it('deriveSafetyTier infers ir-fire-forget from commandType: customize', () => {
      expect(deriveSafetyTier({ command: 'x', parameter: '-', description: '', commandType: 'customize' }))
        .toBe('ir-fire-forget');
    });

    it('deriveSafetyTier defaults physical to mutation', () => {
      expect(deriveSafetyTier({ command: 'x', parameter: '-', description: '' }, { category: 'physical' }))
        .toBe('mutation');
    });

    it('getCommandSafetyReason returns safetyReason', () => {
      expect(getCommandSafetyReason({ command: 'x', parameter: '-', description: '', safetyReason: 'new' }))
        .toBe('new');
      expect(getCommandSafetyReason({ command: 'x', parameter: '-', description: '' }))
        .toBeNull();
    });
  });

  describe('role assignments', () => {
    const entriesByRole = (role: string) =>
      DEVICE_CATALOG.filter((e) => e.role === role).map((e) => e.type);

    it('assigns lighting role to the known lighting types', () => {
      const lighting = entriesByRole('lighting');
      expect(lighting).toContain('Color Bulb');
      expect(lighting).toContain('Strip Light');
      expect(lighting).toContain('Ceiling Light');
      expect(lighting).toContain('Light');
    });

    it('assigns security role to locks / doorbell / garage / keypad', () => {
      const security = entriesByRole('security');
      expect(security).toContain('Smart Lock');
      expect(security).toContain('Smart Lock Lite');
      expect(security).toContain('Garage Door Opener');
      expect(security).toContain('Keypad');
      expect(security).toContain('Video Doorbell');
      expect(security).toContain('Pan/Tilt Cam Plus 3K');
    });

    it('assigns sensor role + readOnly to Meter / Motion Sensor / Contact Sensor', () => {
      for (const t of ['Meter', 'Motion Sensor', 'Presence Sensor', 'Contact Sensor', 'Water Leak Detector']) {
        const entry = DEVICE_CATALOG.find((e) => e.type === t);
        expect(entry?.role).toBe('sensor');
        expect(entry?.readOnly).toBe(true);
      }
    });

    it('covers official GitHub-documented device types observed in the real account', () => {
      const camera = DEVICE_CATALOG.find((e) => e.type === 'Pan/Tilt Cam Plus 3K');
      const remote = DEVICE_CATALOG.find((e) => e.type === 'Remote');
      const presence = DEVICE_CATALOG.find((e) => e.type === 'Presence Sensor');

      expect(camera).toMatchObject({
        category: 'physical',
        role: 'security',
        readOnly: true,
        commands: [],
      });
      expect(camera?.statusFields).toBeUndefined();
      expect(camera?.aliases).toContain('Pan/Tilt Cam Plus');

      expect(remote).toMatchObject({
        category: 'physical',
        role: 'other',
        readOnly: true,
        commands: [],
      });
      expect(remote?.statusFields).toBeUndefined();
      expect(remote?.aliases).toContain('Wireless Remote');

      expect(presence).toMatchObject({
        category: 'physical',
        role: 'sensor',
        readOnly: true,
        commands: [],
        statusFields: ['version', 'battery', 'lightLevel', 'detected', 'hubDeviceId'],
      });
    });
  });

  describe('suggestedActions', () => {
    it('returns only idempotent, non-destructive commands', () => {
      const lock = DEVICE_CATALOG.find((e) => e.type === 'Smart Lock')!;
      const actions = suggestedActions(lock);
      // unlock is destructive → must be excluded
      expect(actions.find((a) => a.command === 'unlock')).toBeUndefined();
      // lock is idempotent and not destructive → must appear
      expect(actions.find((a) => a.command === 'lock')).toBeDefined();
    });

    it('caps suggestions at 3', () => {
      const bulb = DEVICE_CATALOG.find((e) => e.type === 'Color Bulb')!;
      const actions = suggestedActions(bulb);
      expect(actions.length).toBeLessThanOrEqual(3);
    });

    it('excludes customize commands', () => {
      const others = DEVICE_CATALOG.find((e) => e.type === 'Others')!;
      expect(suggestedActions(others)).toEqual([]);
    });

    it('returns empty array for readOnly / no-command entries', () => {
      const meter = DEVICE_CATALOG.find((e) => e.type === 'Meter')!;
      expect(suggestedActions(meter)).toEqual([]);
    });

    it('surfaces exampleParams when a command has them', () => {
      const bulb = DEVICE_CATALOG.find((e) => e.type === 'Color Bulb')!;
      const actions = suggestedActions(bulb);
      // turnOn comes first — no parameters
      // The brightness/color commands carry exampleParams, but they're idempotent
      // too, so at least one of the picks should have a parameter if the cap
      // allowed for it. With cap=3, picks are [turnOn, turnOff, toggle?]...
      // turnOn is idempotent, turnOff is idempotent, toggle is NOT idempotent.
      // So picks are [turnOn, turnOff, setBrightness]. setBrightness has params.
      const withParam = actions.find((a) => a.parameter);
      expect(withParam).toBeDefined();
    });
  });

  describe('findCatalogEntry (existing)', () => {
    it('resolves Strip Light 3 as its own documented device type', () => {
      const match = findCatalogEntry('Strip Light 3');
      expect(Array.isArray(match)).toBe(false);
      expect((match as { type: string }).type).toBe('Strip Light 3');
    });
  });
});

describe('catalog overlay', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-catalog-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function writeOverlay(entries: unknown): Promise<void> {
    const dir = path.join(tmpRoot, '.switchbot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(entries));
  }

  async function freshImport() {
    vi.resetModules();
    return await import('../../src/devices/catalog.js');
  }

  it('returns empty entries when overlay file is missing', async () => {
    const { loadCatalogOverlay } = await freshImport();
    const result = loadCatalogOverlay();
    expect(result.exists).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it('loads a valid overlay array', async () => {
    await writeOverlay([{ type: 'Bot', role: 'other' }]);
    const { loadCatalogOverlay } = await freshImport();
    const result = loadCatalogOverlay();
    expect(result.exists).toBe(true);
    expect(result.entries).toEqual([{ type: 'Bot', role: 'other' }]);
    expect(result.error).toBeUndefined();
  });

  it('reports an error when overlay is not a JSON array', async () => {
    await writeOverlay({ not: 'an array' });
    const { loadCatalogOverlay } = await freshImport();
    const result = loadCatalogOverlay();
    expect(result.exists).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.error).toMatch(/array/i);
  });

  it('reports an error when an overlay entry is missing string `type`', async () => {
    await writeOverlay([{ role: 'other' }]);
    const { loadCatalogOverlay } = await freshImport();
    const result = loadCatalogOverlay();
    expect(result.error).toMatch(/type/i);
    expect(result.entries).toEqual([]);
  });

  it('reports a parse error for malformed JSON without throwing', async () => {
    const dir = path.join(tmpRoot, '.switchbot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'catalog.json'), '{not valid json');
    const { loadCatalogOverlay } = await freshImport();
    const result = loadCatalogOverlay();
    expect(result.exists).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it('overlay replaces fields on a matching built-in type (partial merge)', async () => {
    await writeOverlay([{ type: 'Bot', role: 'lighting' }]);
    const { getEffectiveCatalog } = await freshImport();
    const eff = getEffectiveCatalog();
    const bot = eff.find((e) => e.type === 'Bot');
    expect(bot?.role).toBe('lighting');
    // Other fields (commands, statusFields) still come from the built-in entry.
    expect(bot?.commands.length).toBeGreaterThan(0);
    expect(bot?.category).toBe('physical');
  });

  it('overlay appends a new type when category+commands are supplied', async () => {
    await writeOverlay([
      {
        type: 'Imaginary Gadget',
        category: 'physical',
        role: 'other',
        commands: [{ command: 'ping', parameter: '—', description: 'Ping it' }],
      },
    ]);
    const { getEffectiveCatalog } = await freshImport();
    const eff = getEffectiveCatalog();
    expect(eff.find((e) => e.type === 'Imaginary Gadget')).toBeDefined();
  });

  it('overlay silently ignores new entries missing category or commands', async () => {
    await writeOverlay([{ type: 'Half Baked', role: 'other' }]);
    const { getEffectiveCatalog } = await freshImport();
    const eff = getEffectiveCatalog();
    expect(eff.find((e) => e.type === 'Half Baked')).toBeUndefined();
  });

  it('overlay removes a built-in type when remove: true', async () => {
    await writeOverlay([{ type: 'Bot', remove: true }]);
    const { getEffectiveCatalog } = await freshImport();
    const eff = getEffectiveCatalog();
    expect(eff.find((e) => e.type === 'Bot')).toBeUndefined();
    // Other built-in types remain.
    expect(eff.find((e) => e.type === 'Curtain')).toBeDefined();
  });

  it('findCatalogEntry respects overlay (alias lookup on overlay-added type)', async () => {
    await writeOverlay([
      {
        type: 'Imaginary Gadget',
        category: 'physical',
        role: 'other',
        aliases: ['ImagGadget'],
        commands: [{ command: 'ping', parameter: '—', description: 'Ping' }],
      },
    ]);
    const { findCatalogEntry: find } = await freshImport();
    const match = find('ImagGadget');
    expect(Array.isArray(match)).toBe(false);
    expect((match as { type: string }).type).toBe('Imaginary Gadget');
  });

  it('resetCatalogOverlayCache re-reads the overlay file on next call', async () => {
    await writeOverlay([{ type: 'Bot', role: 'lighting' }]);
    const { getEffectiveCatalog, resetCatalogOverlayCache } = await freshImport();
    expect(getEffectiveCatalog().find((e) => e.type === 'Bot')?.role).toBe('lighting');

    // Swap overlay contents on disk.
    await writeOverlay([{ type: 'Bot', role: 'sensor' }]);
    // Without refresh, cached snapshot is returned.
    expect(getEffectiveCatalog().find((e) => e.type === 'Bot')?.role).toBe('lighting');
    resetCatalogOverlayCache();
    expect(getEffectiveCatalog().find((e) => e.type === 'Bot')?.role).toBe('sensor');
  });

  it('DEVICE_CATALOG remains untouched by the overlay (no mutation)', async () => {
    await writeOverlay([{ type: 'Bot', remove: true }]);
    const { getEffectiveCatalog, DEVICE_CATALOG: builtin } = await freshImport();
    getEffectiveCatalog(); // force overlay application
    expect(builtin.find((e) => e.type === 'Bot')).toBeDefined();
  });

  // ---------------------------------------------------------------------
  // P11: ReadOnlyQuerySpec / deriveStatusQueries
  // ---------------------------------------------------------------------
  describe('P11: read-tier statusQueries', () => {
    it('deriveStatusQueries returns one spec per statusFields entry for physical devices', async () => {
      const { deriveStatusQueries, DEVICE_CATALOG: cat } = await import('../../src/devices/catalog.js');
      const bot = cat.find((e) => e.type === 'Bot')!;
      const queries = deriveStatusQueries(bot);
      expect(queries.length).toBe(bot.statusFields!.length);
      for (const q of queries) {
        expect(q.safetyTier).toBe('read');
        expect(q.endpoint).toBe('status');
        expect(typeof q.description).toBe('string');
      }
    });

    it('deriveStatusQueries returns [] for IR category entries', async () => {
      const { deriveStatusQueries, DEVICE_CATALOG: cat } = await import('../../src/devices/catalog.js');
      const tv = cat.find((e) => e.type === 'TV')!;
      expect(deriveStatusQueries(tv)).toEqual([]);
    });

    it('deriveStatusQueries returns [] for entries without statusFields', async () => {
      const { deriveStatusQueries } = await import('../../src/devices/catalog.js');
      // Synthetic minimal entry.
      const synthetic = { type: 'X', category: 'physical' as const, commands: [] };
      expect(deriveStatusQueries(synthetic)).toEqual([]);
    });

    it('every physical entry with statusFields produces at least one read query', async () => {
      const { deriveStatusQueries, DEVICE_CATALOG: cat } = await import('../../src/devices/catalog.js');
      for (const entry of cat) {
        if (entry.category !== 'physical' || !entry.statusFields?.length) continue;
        const qs = deriveStatusQueries(entry);
        expect(qs.length).toBeGreaterThan(0);
        for (const q of qs) expect(q.safetyTier).toBe('read');
      }
    });
  });
});
