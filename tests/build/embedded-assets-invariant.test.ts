import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Structural invariant that protects the 3.3.0 bundled-asset fix.
 *
 * The embedded-asset loader works because `src/embedded-assets.ts` sits at
 * the source-tree counterpart of `dist/index.js`, so
 * `new URL('./policy/schema/...', import.meta.url)` resolves to the same
 * relative layout under tsx and under the production bundle. If ANY other
 * file in `src/` calls `new URL(..., import.meta.url)` to read a bundled
 * asset, the path is being interpreted against a different depth and will
 * drift between dev and prod — exactly the bug class that shipped in 3.2.2.
 *
 * This test walks `src/`, greps every `.ts` file for that pattern, and
 * fails if the set of matches is anything other than exactly
 * `src/embedded-assets.ts`. A deep-module contributor reintroducing the
 * helper lights this test up immediately.
 */

const SRC_DIR = path.resolve('src');
const PATTERN = /new URL\([^)]*import\.meta\.url/;
const EXPECTED_SOLE_MATCH = path.join('src', 'embedded-assets.ts');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('embedded-asset loader is the sole reader of bundled assets', () => {
  it('exactly one file in src/ uses new URL(..., import.meta.url)', () => {
    const hits: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const content = fs.readFileSync(file, 'utf-8');
      if (PATTERN.test(content)) {
        hits.push(path.relative(process.cwd(), file).replace(/\\/g, '/'));
      }
    }
    const expected = EXPECTED_SOLE_MATCH.replace(/\\/g, '/');
    expect(
      hits,
      `embedded-asset invariant broken.\n` +
        `Expected exactly: [${expected}]\n` +
        `Actual hits: ${JSON.stringify(hits, null, 2)}\n\n` +
        `Any 'new URL(..., import.meta.url)' outside src/embedded-assets.ts resolves\n` +
        `against the wrong source-tree depth and will break in the production bundle.\n` +
        `Route the caller through an exported loader in src/embedded-assets.ts instead.`,
    ).toEqual([expected]);
  });
});
