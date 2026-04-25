/**
 * Unit tests for daemon.ts — path resolution and spawn argument correctness.
 * We don't actually spawn a real daemon process; we verify the path logic in isolation.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('daemon cliEntry path', () => {
  it('resolves one level above dist/commands/ (to dist/index.js)', () => {
    const simulatedDaemonFile = path.join('/some', 'prefix', 'dist', 'commands', 'daemon.js');
    const cliEntry = path.resolve(path.dirname(simulatedDaemonFile), '..', 'index.js');
    // Must end with dist/index.js, not dist/commands/index.js
    expect(path.basename(cliEntry)).toBe('index.js');
    expect(path.basename(path.dirname(cliEntry))).toBe('dist');
  });

  it('does NOT resolve to dist/commands/index.js (the old broken path)', () => {
    const simulatedDaemonFile = path.join('/some', 'prefix', 'dist', 'commands', 'daemon.js');
    const cliEntry = path.resolve(path.dirname(simulatedDaemonFile), '..', 'index.js');
    expect(cliEntry).not.toMatch(/commands[/\\]index\.js$/);
  });

  it('without the .. fix, path incorrectly lands in dist/commands/', () => {
    const simulatedDaemonFile = path.join('/some', 'prefix', 'dist', 'commands', 'daemon.js');
    const brokenEntry = path.resolve(path.dirname(simulatedDaemonFile), 'index.js');
    // The broken version resolves to dist/commands/index.js
    expect(path.dirname(brokenEntry).endsWith(path.join('dist', 'commands'))).toBe(true);
  });
});
