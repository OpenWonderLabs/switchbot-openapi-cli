import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../helpers/cli.js';
import { registerCatalogCommand } from '../../src/commands/catalog.js';
import { resetCatalogOverlayCache } from '../../src/devices/catalog.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-catalog-cmd-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot);
  resetCatalogOverlayCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetCatalogOverlayCache();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeOverlay(entries: unknown): void {
  const dir = path.join(tmpRoot, '.switchbot');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(entries));
}

describe('catalog path', () => {
  it('reports non-existent overlay with helpful hint', async () => {
    const { stdout, exitCode } = await runCli(registerCatalogCommand, ['catalog', 'path']);
    expect(exitCode).toBeNull();
    const out = stdout.join('\n');
    expect(out).toContain('Overlay path:');
    expect(out).toContain('Exists:       no');
    expect(out).toContain('catalog.json');
  });

  it('reports a valid overlay file', async () => {
    writeOverlay([{ type: 'Bot', role: 'lighting' }]);
    const { stdout } = await runCli(registerCatalogCommand, ['catalog', 'path']);
    const out = stdout.join('\n');
    expect(out).toContain('Exists:       yes');
    expect(out).toContain('valid (1 entry)');
  });

  it('reports an invalid overlay file with the error', async () => {
    const dir = path.join(tmpRoot, '.switchbot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'catalog.json'), '{not json');
    const { stdout } = await runCli(registerCatalogCommand, ['catalog', 'path']);
    const out = stdout.join('\n');
    expect(out).toContain('Status:       invalid');
  });

  it('emits JSON when --json is passed', async () => {
    writeOverlay([{ type: 'Bot' }]);
    const { stdout } = await runCli(registerCatalogCommand, ['--json', 'catalog', 'path']);
    const parsed = JSON.parse(stdout.join('\n'));
    expect(parsed.data.exists).toBe(true);
    expect(parsed.data.valid).toBe(true);
    expect(parsed.data.entryCount).toBe(1);
  });
});

describe('catalog show', () => {
  it('lists the effective catalog by default', async () => {
    const { stdout, exitCode } = await runCli(registerCatalogCommand, ['catalog', 'show']);
    expect(exitCode).toBeNull();
    const out = stdout.join('\n');
    expect(out).toContain('Bot');
    expect(out).toContain('Curtain');
    expect(out).toContain('source: effective');
  });

  it('narrows to a single type by name', async () => {
    const { stdout } = await runCli(registerCatalogCommand, ['catalog', 'show', 'Bot']);
    const out = stdout.join('\n');
    expect(out).toMatch(/Type:\s+Bot/);
    expect(out).toContain('turnOn');
  });

  it('supports multi-word type names unquoted', async () => {
    const { stdout } = await runCli(registerCatalogCommand, ['catalog', 'show', 'Smart', 'Lock']);
    const out = stdout.join('\n');
    // Smart Lock alone matches multiple types via substring — the test exercises
    // that multi-word args concatenate, then findCatalogEntry resolves the exact match.
    expect(out).toMatch(/Smart Lock/);
  });

  it('resolves "Robot Vacuum" to a single catalog entry', async () => {
    const { stdout, exitCode } = await runCli(registerCatalogCommand, ['catalog', 'show', 'Robot', 'Vacuum']);
    expect(exitCode).toBeNull();
    const out = stdout.join('\n');
    expect(out).toContain('Robot Vacuum Cleaner S1');
  });

  it('--source built-in ignores overlay', async () => {
    writeOverlay([{ type: 'Bot', remove: true }]);
    const { stdout } = await runCli(registerCatalogCommand, ['catalog', 'show', '--source', 'built-in']);
    const out = stdout.join('\n');
    expect(out).toContain('Bot');
    expect(out).toContain('source: built-in');
  });

  it('--source overlay shows only full overlay entries', async () => {
    writeOverlay([
      {
        type: 'Imaginary',
        category: 'physical',
        role: 'other',
        commands: [{ command: 'ping', parameter: '—', description: 'Ping' }],
      },
      { type: 'Bot', role: 'lighting' }, // partial override — excluded from overlay view
    ]);
    const { stdout } = await runCli(registerCatalogCommand, ['catalog', 'show', '--source', 'overlay']);
    const out = stdout.join('\n');
    expect(out).toContain('Imaginary');
    // Partial overlay entries are not listed here (they have no commands column to render).
    expect(out).toContain('source: overlay');
  });

  it('--source with unknown value exits with code 2', async () => {
    const { stderr, exitCode } = await runCli(registerCatalogCommand, [
      'catalog',
      'show',
      '--source',
      'bogus',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr.join('\n')).toMatch(/--source.*must be one of/i);
  });

  it('exits 2 when the type does not exist', async () => {
    const { stderr, exitCode } = await runCli(registerCatalogCommand, ['catalog', 'show', 'Nonexistent']);
    expect(exitCode).toBe(2);
    expect(stderr.join('\n')).toContain('No device type matches');
  });

  it('emits JSON array with --json', async () => {
    const { stdout } = await runCli(registerCatalogCommand, ['--json', 'catalog', 'show']);
    const parsed = JSON.parse(stdout.join('\n'));
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data.find((e: { type: string }) => e.type === 'Bot')).toBeDefined();
  });

  it('emits a single-entry JSON object when a type is given', async () => {
    const { stdout } = await runCli(registerCatalogCommand, ['--json', 'catalog', 'show', 'Bot']);
    const parsed = JSON.parse(stdout.join('\n'));
    expect(parsed.data.type).toBe('Bot');
  });
});

describe('catalog diff', () => {
  it('reports no diff when no overlay exists', async () => {
    const { stdout } = await runCli(registerCatalogCommand, ['catalog', 'diff']);
    const out = stdout.join('\n');
    expect(out).toContain('No overlay at');
    expect(out).toContain('matches built-in');
  });

  it('reports replacements, additions, removals, and ignored entries', async () => {
    writeOverlay([
      { type: 'Bot', role: 'lighting' }, // replace
      {
        type: 'New Thing',
        category: 'physical',
        role: 'other',
        commands: [{ command: 'ping', parameter: '—', description: 'Ping' }],
      }, // add
      { type: 'Curtain', remove: true }, // remove
      { type: 'Half Baked', role: 'other' }, // ignored (new, missing category+commands)
    ]);
    const { stdout } = await runCli(registerCatalogCommand, ['catalog', 'diff']);
    const out = stdout.join('\n');
    expect(out).toContain('Replaced:');
    expect(out).toContain('~ Bot');
    expect(out).toContain('role');
    expect(out).toContain('Added:');
    expect(out).toContain('+ New Thing');
    expect(out).toContain('Removed:');
    expect(out).toContain('- Curtain');
    expect(out).toContain('Ignored:');
    expect(out).toContain('! Half Baked');
  });

  it('reports an invalid overlay', async () => {
    const dir = path.join(tmpRoot, '.switchbot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'catalog.json'), '{malformed');
    const { stdout } = await runCli(registerCatalogCommand, ['catalog', 'diff']);
    const out = stdout.join('\n');
    expect(out).toContain('invalid');
  });

  it('emits a structured JSON diff with --json', async () => {
    writeOverlay([
      { type: 'Bot', role: 'lighting' },
      { type: 'Curtain', remove: true },
    ]);
    const { stdout } = await runCli(registerCatalogCommand, ['--json', 'catalog', 'diff']);
    const parsed = JSON.parse(stdout.join('\n'));
    expect(parsed.data.replaced).toHaveLength(1);
    expect(parsed.data.replaced[0].type).toBe('Bot');
    expect(parsed.data.replaced[0].changedKeys).toContain('role');
    expect(parsed.data.removed).toContain('Curtain');
    expect(parsed.data.added).toEqual([]);
  });
});

describe('catalog refresh', () => {
  it('reports a successful refresh when no overlay is present', async () => {
    const { stdout } = await runCli(registerCatalogCommand, ['catalog', 'refresh']);
    const out = stdout.join('\n');
    expect(out).toContain('Overlay cache cleared');
    expect(out).toContain('No overlay file');
  });

  it('reports entry count after a successful refresh', async () => {
    writeOverlay([{ type: 'Bot' }, { type: 'Curtain', remove: true }]);
    const { stdout } = await runCli(registerCatalogCommand, ['catalog', 'refresh']);
    const out = stdout.join('\n');
    expect(out).toContain('Loaded 2 entries');
  });

  it('emits JSON with --json', async () => {
    const { stdout } = await runCli(registerCatalogCommand, ['--json', 'catalog', 'refresh']);
    const parsed = JSON.parse(stdout.join('\n'));
    expect(parsed.data.refreshed).toBe(true);
  });
});

describe('catalog search', () => {
  it('returns hits sorted by match-tier (type > role/command > alias-substring)', async () => {
    // "bot" exists as type "Bot" (tier 0), appears in no roles/commands exactly,
    // and is a substring of other aliases like "robot vacuum" (tier 2).
    const { stdout } = await runCli(registerCatalogCommand, ['--json', 'catalog', 'search', 'bot']);
    const parsed = JSON.parse(stdout.join('\n'));
    const matches = parsed.data.matches as Array<{ type: string; _tier: number; _matchedOn: string[] }>;
    expect(matches.length).toBeGreaterThan(0);
    // First hit must be the exact type (tier 0).
    expect(matches[0].type).toBe('Bot');
    expect(matches[0]._tier).toBe(0);
    expect(matches[0]._matchedOn).toContain('type');
    // Tiers are monotonically non-decreasing.
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i]._tier).toBeGreaterThanOrEqual(matches[i - 1]._tier);
    }
  });

  it('marks alias-substring-only matches as alias-only', async () => {
    const { stdout } = await runCli(registerCatalogCommand, ['--json', 'catalog', 'search', 'bot']);
    const parsed = JSON.parse(stdout.join('\n'));
    const matches = parsed.data.matches as Array<{ type: string; _matchedOn: string[] }>;
    // At least one tier-2 entry should be labelled alias-only.
    const aliasOnly = matches.filter((m) => m._matchedOn.includes('alias-only'));
    expect(aliasOnly.length).toBeGreaterThan(0);
    // And that entry is NOT labelled 'alias' (the exact-alias tag).
    for (const m of aliasOnly) {
      expect(m._matchedOn).not.toContain('alias');
    }
  });

  it('--strict restricts hits to type-name matches only', async () => {
    const { stdout } = await runCli(registerCatalogCommand, [
      '--json',
      'catalog',
      'search',
      'bot',
      '--strict',
    ]);
    const parsed = JSON.parse(stdout.join('\n'));
    const matches = parsed.data.matches as Array<{ type: string; _matchedOn: string[]; _tier: number }>;
    expect(parsed.data.strict).toBe(true);
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m._matchedOn).toContain('type');
      expect(m._tier).toBe(0);
    }
  });

  it('--strict with no type match prints a helpful suffix', async () => {
    const { stdout } = await runCli(registerCatalogCommand, [
      'catalog',
      'search',
      'zzzzznonexistentzzz',
      '--strict',
    ]);
    const out = stdout.join('\n');
    expect(out).toContain('No catalog entries match');
    expect(out).toContain('strict mode');
  });

  it('table output labels the column matched_on', async () => {
    const { stdout } = await runCli(registerCatalogCommand, ['catalog', 'search', 'Bot']);
    const out = stdout.join('\n');
    expect(out).toContain('matched_on');
    // Legacy column header `matched` without the `_on` suffix must be gone.
    expect(out).not.toMatch(/\bmatched\b(?!_)/);
  });
});
