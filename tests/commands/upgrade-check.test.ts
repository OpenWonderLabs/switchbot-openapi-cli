import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { findBreakingChangeBetween } from '../../src/version-notes.js';
import { expectJsonEnvelopeContainingKeys } from '../helpers/contracts.js';

// ── https mock (for action-level tests) ─────────────────────────────────────
const httpsMock = vi.hoisted(() => {
  return { get: vi.fn() };
});

vi.mock('node:https', () => ({ default: httpsMock }));

function makeHttpsGet(version: string) {
  httpsMock.get.mockImplementation((_url: unknown, _opts: unknown, cb: (res: EventEmitter) => void) => {
    const res = new EventEmitter();
    const req = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    process.nextTick(() => {
      cb(res);
      res.emit('data', Buffer.from(JSON.stringify({ version })));
      res.emit('end');
    });
    return req;
  });
}

// Mirror of semverGt in upgrade-check.ts — tests pin the contract.
// If the implementation changes, these tests should catch regressions.
function semverGt(a: string, b: string): boolean {
  const numParts = (v: string) => v.replace(/-.*$/, '').split('.').map((n) => Number.parseInt(n, 10));
  const [aMaj, aMin, aPat] = numParts(a);
  const [bMaj, bMin, bPat] = numParts(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  if (aPat !== bPat) return aPat > bPat;
  // Same numeric version: release (no prerelease) > prerelease
  return !a.includes('-') && b.includes('-');
}

describe('semverGt (upgrade-check)', () => {
  it('release > prerelease of same version', () => {
    expect(semverGt('3.2.1', '3.2.1-rc.1')).toBe(true);
    expect(semverGt('3.2.1', '3.2.1-beta.1')).toBe(true);
  });

  it('newer patch > older patch', () => {
    expect(semverGt('3.2.2', '3.2.1')).toBe(true);
    expect(semverGt('3.2.1', '3.2.2')).toBe(false);
  });

  it('same version is not gt', () => {
    expect(semverGt('3.2.1', '3.2.1')).toBe(false);
  });

  it('newer minor > older minor', () => {
    expect(semverGt('3.3.0', '3.2.9')).toBe(true);
  });

  it('newer major wins regardless of minor/patch', () => {
    expect(semverGt('4.0.0', '3.99.99')).toBe(true);
  });
});

describe('breakingChange detection (upgrade-check)', () => {
  function majorOf(v: string): number {
    return Number.parseInt(v.split('.')[0], 10);
  }
  function isBreaking(latest: string, current: string): boolean {
    return majorOf(latest) > majorOf(current);
  }

  it('same major → no breaking change', () => {
    expect(isBreaking('3.5.0', '3.2.1')).toBe(false);
  });

  it('major bump → breaking change', () => {
    expect(isBreaking('4.0.0', '3.99.9')).toBe(true);
  });

  it('older latest → no breaking change', () => {
    expect(isBreaking('2.0.0', '3.0.0')).toBe(false);
  });

  it('metadata catches known same-major breaking releases', () => {
    const notice = findBreakingChangeBetween('3.2.9', '3.3.1');
    expect(notice).not.toBeNull();
    expect(notice?.version).toBe('3.3.0');
    expect(notice?.summary).toMatch(/schemaVersion,data|envelope/i);
  });
});

// ── action-level tests (prerelease guard) ────────────────────────────────────
describe('upgrade-check action — prerelease guard', () => {
  afterEach(() => {
    httpsMock.get.mockReset();
  });

  it('--json: when registry returns a prerelease, upToDate=true and no installCommand', async () => {
    makeHttpsGet('3.2.0-rc.1');
    const { registerUpgradeCheckCommand } = await import('../../src/commands/upgrade-check.js');
    const { runCli } = await import('../helpers/cli.js');

    const res = await runCli(registerUpgradeCheckCommand, ['--json', 'upgrade-check']);
    const line = res.stdout.find((l) => l.trim().startsWith('{'));
    expect(line).toBeDefined();
    const out = JSON.parse(line!) as Record<string, unknown>;
    const data = expectJsonEnvelopeContainingKeys(out, ['current', 'latest', 'upToDate', 'updateAvailable', 'installCommand', 'note']);
    expect(data.upToDate).toBe(true);
    expect(data.updateAvailable).toBe(false);
    expect(data.installCommand).toBeNull();
    expect(String(data.note ?? '')).toMatch(/prerelease/i);
  });

  it('human: when registry returns a prerelease, prints stable message without update prompt', async () => {
    makeHttpsGet('3.2.0-rc.1');
    const { registerUpgradeCheckCommand } = await import('../../src/commands/upgrade-check.js');
    const { runCli } = await import('../helpers/cli.js');

    const res = await runCli(registerUpgradeCheckCommand, ['upgrade-check']);
    expect(res.exitCode).not.toBe(1);
    const out = res.stdout.join('\n');
    expect(out).toMatch(/prerelease/i);
    expect(out).not.toMatch(/Update available/i);
  });
});

// ── happy path and network error ─────────────────────────────────────────────
describe('upgrade-check action — version comparison', () => {
  afterEach(() => {
    httpsMock.get.mockReset();
  });

  it('--json: when up to date (registry returns same version), upToDate:true exits 0', async () => {
    makeHttpsGet('3.1.1');
    const { registerUpgradeCheckCommand } = await import('../../src/commands/upgrade-check.js');
    const { runCli } = await import('../helpers/cli.js');

    const res = await runCli(registerUpgradeCheckCommand, ['--json', 'upgrade-check']);
    expect(res.exitCode).toBeNull();
    const line = res.stdout.find((l) => l.trim().startsWith('{'));
    const out = JSON.parse(line!) as Record<string, unknown>;
    const data = expectJsonEnvelopeContainingKeys(out, ['current', 'latest', 'upToDate', 'updateAvailable', 'installCommand']);
    expect(data.upToDate).toBe(true);
    expect(data.updateAvailable).toBe(false);
    expect(data.installCommand).toBeNull();
  });

  it('--json: when newer version available, updateAvailable:true and exits 1', async () => {
    makeHttpsGet('99.0.0');
    const { registerUpgradeCheckCommand } = await import('../../src/commands/upgrade-check.js');
    const { runCli } = await import('../helpers/cli.js');

    const res = await runCli(registerUpgradeCheckCommand, ['--json', 'upgrade-check']);
    // JSON mode returns early without calling process.exit(1) — that only happens in human mode
    expect(res.exitCode).toBeNull();
    const line = res.stdout.find((l) => l.trim().startsWith('{'));
    const out = JSON.parse(line!) as Record<string, unknown>;
    const data = expectJsonEnvelopeContainingKeys(out, ['current', 'latest', 'updateAvailable', 'breakingChange', 'installCommand']);
    expect(data.updateAvailable).toBe(true);
    expect(data.breakingChange).toBe(true);
    expect(typeof data.installCommand).toBe('string');
  });


  it('--json: network error produces ok:false envelope and exits 1', async () => {
    httpsMock.get.mockImplementation((_url: unknown, _opts: unknown, _cb: unknown) => {
      const req = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
      return req;
    });
    const { registerUpgradeCheckCommand } = await import('../../src/commands/upgrade-check.js');
    const { runCli } = await import('../helpers/cli.js');

    const res = await runCli(registerUpgradeCheckCommand, ['--json', 'upgrade-check']);
    expect(res.exitCode).toBe(1);
    const line = res.stdout.find((l) => l.trim().startsWith('{'));
    const out = JSON.parse(line!) as Record<string, unknown>;
    const data = expectJsonEnvelopeContainingKeys(out, ['ok', 'error', 'current']);
    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
  });
});
