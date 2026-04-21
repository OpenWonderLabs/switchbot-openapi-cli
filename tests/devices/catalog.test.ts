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

    it('deriveSafetyTier infers destructive from legacy destructive: true', () => {
      expect(deriveSafetyTier({ command: 'x', parameter: '-', description: '', destructive: true }))
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

    it('getCommandSafetyReason falls back to legacy destructiveReason', () => {
      expect(getCommandSafetyReason({ command: 'x', parameter: '-', description: '', destructiveReason: 'legacy' }))
        .toBe('legacy');
      expect(getCommandSafetyReason({ command: 'x', parameter: '-', description: '', safetyReason: 'new' }))
        .toBe('new');
      // safetyReason wins over destructiveReason when both are set.
      expect(getCommandSafetyReason({ command: 'x', parameter: '-', description: '', safetyReason: 'new', destructiveReason: 'legacy' }))
        .toBe('new');
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
    });

    it('assigns sensor role + readOnly to Meter / Motion Sensor / Contact Sensor', () => {
      for (const t of ['Meter', 'Motion Sensor', 'Contact Sensor', 'Water Leak Detector']) {
        const entry = DEVICE_CATALOG.find((e) => e.type === t);
        expect(entry?.role).toBe('sensor');
        expect(entry?.readOnly).toBe(true);
      }
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
    it('resolves Strip Light 3 via alias to Strip Light', () => {
      const match = findCatalogEntry('Strip Light 3');
      expect(Array.isArray(match)).toBe(false);
      expect((match as { type: string }).type).toBe('Strip Light');
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
});
