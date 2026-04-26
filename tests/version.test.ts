import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Read the real package.json (NOT an import — keeps this decoupled from tsc's
// JSON import assertion setup and mirrors what publish.yml does in CI).
const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(here, '..', 'package.json'), 'utf-8'),
) as { version: string };

describe('CLI --version', () => {
  it('keeps a node shebang on dist/index.js for npm bin execution', () => {
    const cli = readFileSync(path.join(here, '..', 'dist', 'index.js'), 'utf-8');
    expect(cli.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('matches package.json version', () => {
    // Regression guard for the v1.3.1 bug where src/index.ts hardcoded a
    // stale version string. execFileSync + process.execPath avoids shell
    // quoting and PATH lookup issues on Windows/macOS/Linux.
    const out = execFileSync(
      process.execPath,
      ['dist/index.js', '--version'],
      { encoding: 'utf-8' },
    ).trim();
    expect(out).toBe(pkg.version);
  });
});
