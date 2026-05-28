import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const readmeContent = readFileSync(
  path.join(here, '..', 'README.md'),
  'utf-8',
);

describe('README.md — Route B documentation', () => {
  it('mentions "Route B" to explain marketplace.json purpose', () => {
    expect(readmeContent.toLowerCase()).toMatch(/route\s+b/i);
  });

  it('explains marketplace.json in context of Codex or Route B', () => {
    // marketplace.json should be mentioned near codex or route b
    expect(readmeContent).toContain('marketplace.json');
    const marketplaceMatch = readmeContent.indexOf('marketplace.json');
    const contextBefore = readmeContent.slice(
      Math.max(0, marketplaceMatch - 300),
      marketplaceMatch + 300,
    );
    // Should be in a context that mentions codex or route
    expect(
      contextBefore.toLowerCase().includes('codex') ||
        contextBefore.toLowerCase().includes('route'),
    ).toBe(true);
  });

  it('clarifies that root marketplace.json is not for Claude Code users', () => {
    const content = readmeContent.toLowerCase();
    // Should have markers that clarify the file is not for Claude Code npm install
    const hasClaudeCodeOrNote =
      content.includes('claude code') || content.includes('not for');
    expect(hasClaudeCodeOrNote).toBe(true);
  });
});
