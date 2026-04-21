import { describe, it, expect } from 'vitest';
import {
  parseFilter,
  parseFilterExpr,
  matchClause,
  applyFilter,
  FilterSyntaxError,
  type FilterClause,
} from '../../src/utils/filter.js';
import type { Device, InfraredDevice } from '../../src/lib/devices.js';

const devices: Device[] = [
  { deviceId: 'BOT1', deviceName: 'Kitchen Bot', deviceType: 'Bot', familyName: 'Home', roomName: 'Kitchen', enableCloudService: true, hubDeviceId: 'HUB1' },
  { deviceId: 'BOT2', deviceName: 'Office Bot', deviceType: 'Bot', familyName: 'Home', roomName: 'Office', enableCloudService: true, hubDeviceId: 'HUB1' },
  { deviceId: 'BOT3', deviceName: 'Garage Bot Plus', deviceType: 'Bot Plus', familyName: 'Home', roomName: 'Garage', enableCloudService: true, hubDeviceId: 'HUB1' },
  { deviceId: 'LAMP', deviceName: 'Desk', deviceType: 'Color Bulb', familyName: 'Home', roomName: 'Office', enableCloudService: true, hubDeviceId: 'HUB1' },
  { deviceId: 'METER', deviceName: 'Outside', deviceType: 'Meter', familyName: 'Cabin', roomName: 'Porch', enableCloudService: true, hubDeviceId: 'HUB2' },
];

const irRemotes: InfraredDevice[] = [
  { deviceId: 'TV1', deviceName: 'Living TV', remoteType: 'TV', hubDeviceId: 'HUB1' },
  { deviceId: 'AC1', deviceName: 'Bedroom AC', remoteType: 'Air Conditioner', hubDeviceId: 'HUB2' },
];

const hubLoc = new Map([
  ['HUB1', { family: 'Home', room: 'Living' }],
  ['HUB2', { family: 'Cabin', room: 'Bedroom' }],
]);

describe('parseFilter (batch-key default)', () => {
  it('returns [] for undefined / empty string', () => {
    expect(parseFilter(undefined)).toEqual([]);
    expect(parseFilter('')).toEqual([]);
    expect(parseFilter('   ')).toEqual([]);
  });

  it('parses "key=value" as an eq clause (raw preserved)', () => {
    expect(parseFilter('type=Bot')).toEqual([
      { key: 'type', op: 'eq', raw: 'Bot', regex: undefined },
    ]);
  });

  it('parses "key~value" as a sub clause', () => {
    expect(parseFilter('type~Light')).toEqual([
      { key: 'type', op: 'sub', raw: 'Light', regex: undefined },
    ]);
  });

  it('parses "key!=value" as a neq clause (2.6.0)', () => {
    expect(parseFilter('type!=Meter')).toEqual([
      { key: 'type', op: 'neq', raw: 'Meter', regex: undefined },
    ]);
  });

  it('!= takes precedence over = when both appear (not-equals is the intended op)', () => {
    const [c] = parseFilter('type!=Bot');
    expect(c.op).toBe('neq');
    expect(c.raw).toBe('Bot');
  });

  it('parses "key=/pattern/" as a regex clause with case-insensitive RegExp', () => {
    const [c] = parseFilter('type=/Bot.*/');
    expect(c.key).toBe('type');
    expect(c.op).toBe('regex');
    expect(c.raw).toBe('Bot.*');
    expect(c.regex?.source).toBe('Bot.*');
    expect(c.regex?.flags).toContain('i');
  });

  it('rejects the legacy "~=" spelling with a helpful hint', () => {
    expect(() => parseFilter('type~=Light')).toThrow(FilterSyntaxError);
    expect(() => parseFilter('type~=Light')).toThrow(/~=.*no longer supported/);
  });

  it('rejects invalid regex with FilterSyntaxError', () => {
    expect(() => parseFilter('type=/[/')).toThrow(FilterSyntaxError);
  });

  it('parses multi-clause AND expressions', () => {
    const clauses = parseFilter('type=Bot,family=Home');
    expect(clauses).toHaveLength(2);
    expect(clauses[0].key).toBe('type');
    expect(clauses[1].key).toBe('family');
  });

  it('trims whitespace around keys and values', () => {
    const [c] = parseFilter('  type  =   Bot Plus  ');
    expect(c).toEqual({ key: 'type', op: 'eq', raw: 'Bot Plus', regex: undefined });
  });

  it('rejects unknown keys', () => {
    expect(() => parseFilter('color=red')).toThrow(FilterSyntaxError);
  });

  it('rejects malformed clauses (no operator)', () => {
    expect(() => parseFilter('foo')).toThrow(FilterSyntaxError);
  });

  it('rejects empty values', () => {
    expect(() => parseFilter('type=')).toThrow(FilterSyntaxError);
  });
});

describe('parseFilterExpr with custom allowedKeys', () => {
  it('accepts events-tail keys (deviceId, type)', () => {
    const c = parseFilterExpr('deviceId=ABC,type~Bot', ['deviceId', 'type']);
    expect(c).toHaveLength(2);
    expect(c[0]).toEqual({ key: 'deviceId', op: 'eq', raw: 'ABC', regex: undefined });
    expect(c[1]).toEqual({ key: 'type', op: 'sub', raw: 'Bot', regex: undefined });
  });

  it('rejects keys outside the allowed set', () => {
    expect(() => parseFilterExpr('family=Home', ['deviceId', 'type'])).toThrow(
      FilterSyntaxError,
    );
  });

  it('accepts list keys including "name"', () => {
    const [c] = parseFilterExpr('name~office', ['type', 'name', 'category', 'room']);
    expect(c).toEqual({ key: 'name', op: 'sub', raw: 'office', regex: undefined });
  });
});

describe('matchClause', () => {
  const sub = (key: string, raw: string): FilterClause => ({ key, op: 'sub', raw });
  const eq = (key: string, raw: string): FilterClause => ({ key, op: 'eq', raw });
  const rx = (key: string, src: string): FilterClause => ({
    key,
    op: 'regex',
    raw: src,
    regex: new RegExp(src, 'i'),
  });

  it('sub is a case-insensitive substring match', () => {
    expect(matchClause('Color Bulb', sub('type', 'color'))).toBe(true);
    expect(matchClause('Color Bulb', sub('type', 'BULB'))).toBe(true);
    expect(matchClause('Color Bulb', sub('type', 'neon'))).toBe(false);
  });

  it('eq is substring for non-exact keys', () => {
    expect(matchClause('Bot Plus', eq('type', 'Bot'))).toBe(true);
    expect(matchClause('Color Bulb', eq('type', 'neon'))).toBe(false);
  });

  it('eq is exact (case-insensitive) for "category" by default', () => {
    expect(matchClause('physical', eq('category', 'physical'))).toBe(true);
    expect(matchClause('physical', eq('category', 'phys'))).toBe(false);
    expect(matchClause('IR', eq('category', 'ir'))).toBe(true);
  });

  it('regex.test against the raw candidate (not lowercased)', () => {
    expect(matchClause('Bot Plus', rx('type', 'Bot.*'))).toBe(true);
    expect(matchClause('Air Conditioner', rx('type', '^Air'))).toBe(true);
    expect(matchClause('Air Conditioner', rx('type', 'conditioner'))).toBe(true);
    expect(matchClause('TV', rx('type', 'conditioner'))).toBe(false);
  });

  it('undefined candidate never matches', () => {
    expect(matchClause(undefined, sub('family', 'Home'))).toBe(false);
    expect(matchClause(undefined, eq('category', 'physical'))).toBe(false);
  });

  it('custom exactKeys can make any key exact', () => {
    expect(
      matchClause('Bot Plus', eq('type', 'Bot'), { exactKeys: ['type'] }),
    ).toBe(false);
    expect(
      matchClause('Bot', eq('type', 'Bot'), { exactKeys: ['type'] }),
    ).toBe(true);
  });
});

describe('applyFilter', () => {
  it('returns every candidate when the clause list is empty', () => {
    const all = applyFilter([], devices, irRemotes, hubLoc);
    expect(all.map((d) => d.deviceId).sort()).toEqual(
      ['AC1', 'BOT1', 'BOT2', 'BOT3', 'LAMP', 'METER', 'TV1'],
    );
  });

  it('type=Bot is now a substring match (was exact in <=2.5.0) — also hits Bot Plus', () => {
    const matched = applyFilter(parseFilter('type=Bot'), devices, irRemotes, hubLoc);
    expect(matched.map((d) => d.deviceId).sort()).toEqual(['BOT1', 'BOT2', 'BOT3']);
  });

  it('type!=Meter (2.6.0) excludes Meter devices via negated substring', () => {
    const matched = applyFilter(parseFilter('type!=Meter'), devices, irRemotes, hubLoc);
    expect(matched.map((d) => d.deviceId)).not.toContain('METER');
    expect(matched.map((d) => d.deviceId).sort()).toEqual(
      ['AC1', 'BOT1', 'BOT2', 'BOT3', 'LAMP', 'TV1'],
    );
  });

  it('category!=ir is exact-negated (never substring) — physical only', () => {
    const matched = applyFilter(parseFilter('category!=ir'), devices, irRemotes, hubLoc);
    expect(matched.map((d) => d.deviceId).sort()).toEqual(
      ['BOT1', 'BOT2', 'BOT3', 'LAMP', 'METER'],
    );
  });

  it('combines != with = (AND)', () => {
    const matched = applyFilter(
      parseFilter('type!=Meter,family=Home'),
      devices,
      irRemotes,
      hubLoc,
    );
    expect(matched.map((d) => d.deviceId).sort()).toEqual(
      ['BOT1', 'BOT2', 'BOT3', 'LAMP', 'TV1'],
    );
  });

  it('substring match with ~ is case-insensitive', () => {
    const meter = applyFilter(parseFilter('type~met'), devices, irRemotes, hubLoc);
    expect(meter.map((d) => d.deviceId)).toEqual(['METER']);
    const bulb = applyFilter(parseFilter('type~bulb'), devices, irRemotes, hubLoc);
    expect(bulb.map((d) => d.deviceId)).toEqual(['LAMP']);
  });

  it('regex filter supports alternation', () => {
    const matched = applyFilter(
      parseFilter('type=/Bulb|Meter/'),
      devices,
      irRemotes,
      hubLoc,
    );
    expect(matched.map((d) => d.deviceId).sort()).toEqual(['LAMP', 'METER']);
  });

  it('AND-joins multiple clauses', () => {
    const matched = applyFilter(
      parseFilter('type=Bot,room=Office'),
      devices,
      irRemotes,
      hubLoc,
    );
    expect(matched.map((d) => d.deviceId)).toEqual(['BOT2']);
  });

  it('matches IR remotes by family inherited from the hub', () => {
    const matched = applyFilter(parseFilter('family=Cabin'), devices, irRemotes, hubLoc);
    expect(matched.map((d) => d.deviceId).sort()).toEqual(['AC1', 'METER']);
  });

  it('filters by category=ir (exact, never substring)', () => {
    const matched = applyFilter(parseFilter('category=ir'), devices, irRemotes, hubLoc);
    expect(matched.map((d) => d.deviceId).sort()).toEqual(['AC1', 'TV1']);
  });

  it('filters by category=physical (exact)', () => {
    const matched = applyFilter(parseFilter('category=physical'), devices, irRemotes, hubLoc);
    expect(matched.map((d) => d.deviceId).sort()).toEqual(['BOT1', 'BOT2', 'BOT3', 'LAMP', 'METER']);
  });

  it('category=phys (substring prefix) returns empty because category is exact', () => {
    const matched = applyFilter(parseFilter('category=phys'), devices, irRemotes, hubLoc);
    expect(matched).toEqual([]);
  });

  it('returns empty when a clause has no matches', () => {
    const matched = applyFilter(parseFilter('type=Unicorn'), devices, irRemotes, hubLoc);
    expect(matched).toEqual([]);
  });
});
