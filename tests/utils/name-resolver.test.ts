import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { resolveDeviceId } from '../../src/utils/name-resolver.js';
import { updateCacheFromDeviceList, resetListCache } from '../../src/devices/cache.js';
import { saveDeviceMeta } from '../../src/devices/device-meta.js';

vi.mock('../../src/utils/flags.js', () => ({ getConfigPath: () => undefined, getProfile: () => undefined }));

const sampleBody = {
  deviceList: [
    { deviceId: 'LAMP-ABC', deviceName: 'Living Room Lamp', deviceType: 'Color Bulb', hubDeviceId: 'H1', enableCloudService: true },
    { deviceId: 'BOT-001',  deviceName: 'Kitchen Bot',      deviceType: 'Bot',        hubDeviceId: 'H1', enableCloudService: true },
    { deviceId: 'LAMP-XYZ', deviceName: 'Bedroom Lamp',     deviceType: 'Color Bulb', hubDeviceId: 'H1', enableCloudService: true },
  ],
  infraredRemoteList: [
    { deviceId: 'AC-001', deviceName: 'Living AC', remoteType: 'Air Conditioner', hubDeviceId: 'H1' },
  ],
};

describe('resolveDeviceId', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(`${os.tmpdir()}/sbcli-resolver-`);
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    resetListCache();
    updateCacheFromDeviceList(sampleBody);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetListCache();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it('passes through deviceId when provided', () => {
    expect(resolveDeviceId('LAMP-ABC', undefined)).toBe('LAMP-ABC');
  });

  it('throws when both deviceId and name are provided', () => {
    expect(() => resolveDeviceId('LAMP-ABC', 'Living Lamp')).toThrow('both');
  });

  it('throws when neither is provided', () => {
    expect(() => resolveDeviceId(undefined, undefined)).toThrow('required');
  });

  it('resolves by exact name match', () => {
    expect(resolveDeviceId(undefined, 'Kitchen Bot')).toBe('BOT-001');
  });

  it('resolves by case-insensitive exact match', () => {
    expect(resolveDeviceId(undefined, 'kitchen bot')).toBe('BOT-001');
  });

  it('resolves by substring match', () => {
    expect(resolveDeviceId(undefined, 'Kitchen')).toBe('BOT-001');
  });

  it('resolves by fuzzy match (1 typo)', () => {
    expect(resolveDeviceId(undefined, 'Kitchin Bot')).toBe('BOT-001');
  });

  it('throws StructuredUsageError with candidates on ambiguous match', () => {
    let err: Error | null = null;
    try { resolveDeviceId(undefined, 'Lamp'); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('ambiguous');
    // StructuredUsageError should have context with candidates
    const structured = err as { context?: { candidates?: unknown[] } };
    expect(structured.context?.candidates).toBeDefined();
    expect(Array.isArray(structured.context?.candidates)).toBe(true);
  });

  it('throws on no match', () => {
    expect(() => resolveDeviceId(undefined, 'xyzzy-nonexistent')).toThrow('No device matches');
  });

  it('alias takes priority over fuzzy name match', () => {
    saveDeviceMeta({ version: '1', devices: { 'AC-001': { alias: 'Main AC' } } });
    expect(resolveDeviceId(undefined, 'Main AC')).toBe('AC-001');
  });

  it('throws when cache is empty (no devices list run)', () => {
    resetListCache();
    expect(() => resolveDeviceId(undefined, 'anything')).toThrow('devices list');
  });
});

describe('resolveDeviceId narrowing + strategies', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(`${os.tmpdir()}/sbcli-resolver-narrow-`);
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    resetListCache();
    updateCacheFromDeviceList({
      deviceList: [
        { deviceId: 'BOT-LIVING', deviceName: 'Living Switch', deviceType: 'Bot', hubDeviceId: 'H1', enableCloudService: true, roomName: 'Living Room' },
        { deviceId: 'LAMP-LIVING', deviceName: 'Living Lamp', deviceType: 'Color Bulb', hubDeviceId: 'H1', enableCloudService: true, roomName: 'Living Room' },
        { deviceId: 'BOT-BED', deviceName: 'Bedroom Switch', deviceType: 'Bot', hubDeviceId: 'H1', enableCloudService: true, roomName: 'Bedroom' },
      ],
      infraredRemoteList: [
        { deviceId: 'AC-LIVING', deviceName: 'Living AC', remoteType: 'Air Conditioner', hubDeviceId: 'H1' },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetListCache();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it('filters by --name-type', () => {
    // "Switch" matches both Bots; narrowing by type="Bot" still leaves two → ambiguous
    expect(() => resolveDeviceId(undefined, 'Switch', { type: 'Bot' })).toThrow('ambiguous');
    // narrow with a non-matching type → no match
    expect(() => resolveDeviceId(undefined, 'Switch', { type: 'Curtain' })).toThrow('No device');
  });

  it('filters by --name-category (ir vs physical)', () => {
    // "Living" alone is ambiguous across 3 devices; narrow to ir → 1 match
    expect(resolveDeviceId(undefined, 'Living', { category: 'ir' })).toBe('AC-LIVING');
  });

  it('filters by --name-room', () => {
    // "Switch" narrows by room=Bedroom → only BOT-BED
    expect(resolveDeviceId(undefined, 'Switch', { room: 'Bedroom' })).toBe('BOT-BED');
  });

  it('strategy=exact rejects substring matches', () => {
    expect(() => resolveDeviceId(undefined, 'Living', { strategy: 'exact' })).toThrow('No device');
    // exact match still succeeds
    expect(resolveDeviceId(undefined, 'Living Lamp', { strategy: 'exact' })).toBe('LAMP-LIVING');
  });

  it('strategy=prefix matches by prefix only', () => {
    expect(resolveDeviceId(undefined, 'Bedroom', { strategy: 'prefix' })).toBe('BOT-BED');
  });

  it('strategy=first returns the top scored candidate without ambiguity error', () => {
    // "Living" matches 3 devices; first strategy picks the top-scored one
    const id = resolveDeviceId(undefined, 'Living', { strategy: 'first' });
    expect(['BOT-LIVING', 'LAMP-LIVING', 'AC-LIVING']).toContain(id);
  });

  it('strategy=require-unique throws on multi-match even with low distance', () => {
    // fuzzy might collapse a near-tie cluster to 1; require-unique refuses to pick
    let err: Error | null = null;
    try { resolveDeviceId(undefined, 'Living', { strategy: 'require-unique' }); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/ambiguous/i);
    const structured = err as { context?: { error?: string; candidates?: unknown[] } };
    expect(structured.context?.error).toBe('ambiguous_name_match');
    expect(Array.isArray(structured.context?.candidates)).toBe(true);
  });

  it('invalid strategy raises UsageError', () => {
    expect(() => resolveDeviceId(undefined, 'anything', { strategy: 'bogus' as never }))
      .toThrow('--name-strategy');
  });

  it('ambiguous_name_match error includes hint pointing at narrow flags', () => {
    let err: Error | null = null;
    try { resolveDeviceId(undefined, 'Living', { strategy: 'require-unique' }); } catch (e) { err = e as Error; }
    const structured = err as { context?: { hint?: string } };
    expect(structured.context?.hint).toMatch(/--name-type|--name-room|--name-category|deviceId|--name-strategy/);
  });
});

// Bug #1 regression suite: require-unique must not short-circuit on exact match
describe('resolveDeviceId require-unique exact-match edge cases (bug #1)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(`${os.tmpdir()}/sbcli-resolver-bug1-`);
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    resetListCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetListCache();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it('require-unique: exact match + substring match → ambiguous (reporter scenario)', () => {
    // Device A has name exactly '空调'; device B has '空调' as a substring.
    // Under require-unique the caller expects a unique match, but since B also
    // matches (substring) the result must be ambiguous — NOT a silent pick of A.
    updateCacheFromDeviceList({
      deviceList: [],
      infraredRemoteList: [
        { deviceId: 'A', deviceName: '空调',   remoteType: 'Air Conditioner', hubDeviceId: 'H1' },
        { deviceId: 'B', deviceName: '卧室空调', remoteType: 'Air Conditioner', hubDeviceId: 'H1' },
      ],
    });

    let err: Error | null = null;
    try {
      resolveDeviceId(undefined, '空调', { strategy: 'require-unique' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/ambiguous/i);
    const structured = err as { context?: { error?: string; candidates?: unknown[] } };
    expect(structured.context?.error).toBe('ambiguous_name_match');
    expect(Array.isArray(structured.context?.candidates)).toBe(true);
    expect((structured.context?.candidates as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('require-unique: two devices with the same exact name → ambiguous', () => {
    updateCacheFromDeviceList({
      deviceList: [],
      infraredRemoteList: [
        { deviceId: 'A', deviceName: '空调', remoteType: 'Air Conditioner', hubDeviceId: 'H1' },
        { deviceId: 'B', deviceName: '空调', remoteType: 'Air Conditioner', hubDeviceId: 'H1' },
      ],
    });

    let err: Error | null = null;
    try {
      resolveDeviceId(undefined, '空调', { strategy: 'require-unique' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/ambiguous/i);
    const structured = err as { context?: { error?: string } };
    expect(structured.context?.error).toBe('ambiguous_name_match');
  });

  it('require-unique: single exact match, no other matches → succeeds', () => {
    updateCacheFromDeviceList({
      deviceList: [],
      infraredRemoteList: [
        { deviceId: 'A', deviceName: '空调',   remoteType: 'Air Conditioner', hubDeviceId: 'H1' },
        { deviceId: 'B', deviceName: '风扇',   remoteType: 'Fan',             hubDeviceId: 'H1' },
      ],
    });

    expect(resolveDeviceId(undefined, '空调', { strategy: 'require-unique' })).toBe('A');
  });

  it('fuzzy: exact match short-circuits even with a substring match elsewhere (no regression)', () => {
    // Under fuzzy strategy the exact hit SHOULD short-circuit — ensure we do not regress that.
    updateCacheFromDeviceList({
      deviceList: [],
      infraredRemoteList: [
        { deviceId: 'A', deviceName: '空调',   remoteType: 'Air Conditioner', hubDeviceId: 'H1' },
        { deviceId: 'B', deviceName: '卧室空调', remoteType: 'Air Conditioner', hubDeviceId: 'H1' },
      ],
    });

    // fuzzy: exact-match wins immediately → returns A, no ambiguity error
    const id = resolveDeviceId(undefined, '空调', { strategy: 'fuzzy' });
    expect(id).toBe('A');
  });
});
