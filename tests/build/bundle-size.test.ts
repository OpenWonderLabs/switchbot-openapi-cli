import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('production bundle size', () => {
  const distEntry = path.resolve('dist/index.js');

  // tsc output has relative imports like `from './utils/...'`; esbuild inlines everything.
  function isBundledOutput(): boolean {
    if (!fs.existsSync(distEntry)) return false;
    const head = fs.readFileSync(distEntry, 'utf-8').slice(0, 4096);
    return !head.includes("from './");
  }

  it('dist/index.js exists', () => {
    expect(fs.existsSync(distEntry)).toBe(true);
  });

  it('esbuild bundle is under 15 MB (skipped when tsc output is present)', () => {
    if (!isBundledOutput()) {
      // CI runs `npm run build` (tsc), not `npm run build:prod` (esbuild).
      // Skip size guard when the single-file esbuild bundle has not been built.
      return;
    }
    const { size } = fs.statSync(distEntry);
    const sizeMb = size / (1024 * 1024);
    expect(sizeMb, `dist/index.js is ${sizeMb.toFixed(1)} MB — exceeds 15 MB budget`).toBeLessThan(15);
  });
});
