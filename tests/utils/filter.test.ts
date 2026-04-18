import { describe, it, expect } from 'vitest';
import { parseFilter, applyFilter, FilterSyntaxError } from '../../src/utils/filter.js';
import type { Device, InfraredDevice } from '../../src/lib/devices.js';

const devices: Device[] = [
  { deviceId: 'BOT1', deviceName: 'Kitchen Bot', deviceType: 'Bot', familyName: 'Home', roomName: 'Kitchen', enableCloudService: true, hubDeviceId: 'HUB1' },
  { deviceId: 'BOT2', deviceName: 'Office Bot', deviceType: 'Bot', familyName: 'Home', roomName: 'Office', enableCloudService: true, hubDeviceId: 'HUB1' },
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

describe('parseFilter', () => {
  it('returns [] for undefined / empty string', () => {
    expect(parseFilter(undefined)).toEqual([]);
    expect(parseFilter('')).toEqual([]);
    expect(parseFilter('   ')).toEqual([]);
  });

  it('parses a single exact clause', () => {
    expect(parseFilter('type=Bot')).toEqual([{ key: 'type', op: '=', value: 'Bot' }]);
  });

  it('parses a substring (~=) clause', () => {
    expect(parseFilter('type~=Light')).toEqual([{ key: 'type', op: '~=', value: 'Light' }]);
  });

  it('parses multi-clause AND expressions', () => {
    const clauses = parseFilter('type=Bot,family=Home');
    expect(clauses).toHaveLength(2);
    expect(clauses[0].key).toBe('type');
    expect(clauses[1].key).toBe('family');
  });

  it('trims whitespace around keys and values', () => {
    const [c] = parseFilter('  type  =   Bot Plus  ');
    expect(c).toEqual({ key: 'type', op: '=', value: 'Bot Plus' });
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

describe('applyFilter', () => {
  it('returns every candidate when the clause list is empty', () => {
    const all = applyFilter([], devices, irRemotes, hubLoc);
    expect(all.map((d) => d.deviceId).sort()).toEqual(
      ['AC1', 'BOT1', 'BOT2', 'LAMP', 'METER', 'TV1']
    );
  });

  it('filters by exact type on physical devices', () => {
    const matched = applyFilter(parseFilter('type=Bot'), devices, irRemotes, hubLoc);
    expect(matched.map((d) => d.deviceId).sort()).toEqual(['BOT1', 'BOT2']);
  });

  it('substring match with ~= is case-insensitive', () => {
    const matched = applyFilter(parseFilter('type~=light'), devices, irRemotes, hubLoc);
    // "Color Bulb" doesn't contain "light", so only the IR remotes that do — none here.
    // Let's check against a real substring.
    const meter = applyFilter(parseFilter('type~=met'), devices, irRemotes, hubLoc);
    expect(meter.map((d) => d.deviceId)).toEqual(['METER']);
    expect(matched).toEqual([]); // Color Bulb / Meter / Bot / TV / AC: none contain 'light'
  });

  it('AND-joins multiple clauses', () => {
    const matched = applyFilter(
      parseFilter('type=Bot,room=Office'),
      devices,
      irRemotes,
      hubLoc
    );
    expect(matched.map((d) => d.deviceId)).toEqual(['BOT2']);
  });

  it('matches IR remotes by family inherited from the hub', () => {
    const matched = applyFilter(parseFilter('family=Cabin'), devices, irRemotes, hubLoc);
    expect(matched.map((d) => d.deviceId).sort()).toEqual(['AC1', 'METER']);
  });

  it('filters by category=ir', () => {
    const matched = applyFilter(parseFilter('category=ir'), devices, irRemotes, hubLoc);
    expect(matched.map((d) => d.deviceId).sort()).toEqual(['AC1', 'TV1']);
  });

  it('filters by category=physical', () => {
    const matched = applyFilter(parseFilter('category=physical'), devices, irRemotes, hubLoc);
    expect(matched.map((d) => d.deviceId).sort()).toEqual(['BOT1', 'BOT2', 'LAMP', 'METER']);
  });

  it('returns empty when a clause has no matches', () => {
    const matched = applyFilter(parseFilter('type=Unicorn'), devices, irRemotes, hubLoc);
    expect(matched).toEqual([]);
  });
});
