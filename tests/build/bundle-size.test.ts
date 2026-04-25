import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('production bundle size', () => {
  const distEntry = path.resolve('dist/index.js');

  it('dist/index.js exists', () => {
    expect(fs.existsSync(distEntry)).toBe(true);
  });

  it('dist/index.js is under 15 MB', () => {
    const { size } = fs.statSync(distEntry);
    const sizeMb = size / (1024 * 1024);
    expect(sizeMb, `dist/index.js is ${sizeMb.toFixed(1)} MB — exceeds 15 MB budget`).toBeLessThan(15);
  });
});
