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
    expect(readmeContent).toContain('marketplace.json');

    const term = 'marketplace.json';
    let pos = readmeContent.indexOf(term);
    let hasContext = false;
    while (pos !== -1) {
      const excerpt = readmeContent
        .slice(Math.max(0, pos - 300), pos + 300)
        .toLowerCase();
      if (excerpt.includes('codex') || excerpt.includes('route')) {
        hasContext = true;
        break;
      }
      pos = readmeContent.indexOf(term, pos + 1);
    }
    expect(hasContext).toBe(true);
  });

  it('clarifies that root marketplace.json is not for Claude Code users', () => {
    const term = 'marketplace.json';
    let pos = readmeContent.indexOf(term);
    let found = false;
    while (pos !== -1) {
      const excerpt = readmeContent
        .slice(Math.max(0, pos - 300), pos + 300)
        .toLowerCase();
      if (excerpt.includes('claude code')) {
        found = true;
        break;
      }
      pos = readmeContent.indexOf(term, pos + 1);
    }
    expect(found).toBe(true);
  });
});
