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
    expect(parsed.exists).toBe(true);
    expect(parsed.valid).toBe(true);
    expect(parsed.entryCount).toBe(1);
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
    expect(stderr.join('\n')).toContain('Unknown --source');
  });

  it('exits 2 when the type does not exist', async () => {
    const { stderr, exitCode } = await runCli(registerCatalogCommand, ['catalog', 'show', 'Nonexistent']);
    expect(exitCode).toBe(2);
    expect(stderr.join('\n')).toContain('No device type matches');
  });

  it('emits JSON array with --json', async () => {
    const { stdout } = await runCli(registerCatalogCommand, ['--json', 'catalog', 'show']);
    const parsed = JSON.parse(stdout.join('\n'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.find((e: { type: string }) => e.type === 'Bot')).toBeDefined();
  });

  it('emits a single-entry JSON object when a type is given', async () => {
    const { stdout } = await runCli(registerCatalogCommand, ['--json', 'catalog', 'show', 'Bot']);
    const parsed = JSON.parse(stdout.join('\n'));
    expect(parsed.type).toBe('Bot');
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
    expect(parsed.replaced).toHaveLength(1);
    expect(parsed.replaced[0].type).toBe('Bot');
    expect(parsed.replaced[0].changedKeys).toContain('role');
    expect(parsed.removed).toContain('Curtain');
    expect(parsed.added).toEqual([]);
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
    expect(parsed.refreshed).toBe(true);
  });
});
