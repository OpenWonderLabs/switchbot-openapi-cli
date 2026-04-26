import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Product assertion for `scripts/copy-assets.mjs`.
 *
 * The 3.3.0 embedded-asset loader (`src/embedded-assets.ts`) expects these
 * exact files to land at these exact paths under `dist/`. If a future change
 * to `copy-assets.mjs` drops or relocates one of them, the loader still
 * builds fine but `policy new` / `policy validate` fails at first use —
 * which is the 3.2.2 P0. These tests fail the build instead.
 *
 * `tests/build/embedded-assets-invariant.test.ts` covers the complementary
 * constraint: that only one source file reads bundled assets. Together they
 * pin both sides of the contract.
 */

const REPO_ROOT = path.resolve();
const DIST = path.join(REPO_ROOT, 'dist');

const REQUIRED_ASSETS = [
  path.join('policy', 'schema', 'v0.2.json'),
  path.join('policy', 'examples', 'policy.example.yaml'),
];

describe('copy-assets populates dist/ with the files the loader reads', () => {
  beforeAll(() => {
    // Run the copy step directly (cheap) rather than a full build. The
    // build-prod job has already run dist/ through full build, but we want
    // this test to also pass in isolation (`vitest tests/build/...`).
    execSync('node scripts/copy-assets.mjs', { stdio: 'pipe' });
  }, 15_000);

  for (const rel of REQUIRED_ASSETS) {
    it(`dist/${rel.replace(/\\/g, '/')} exists and is non-empty`, () => {
      const abs = path.join(DIST, rel);
      expect(
        fs.existsSync(abs),
        `Missing asset: ${abs}\n` +
          `scripts/copy-assets.mjs did not produce this file, but src/embedded-assets.ts\n` +
          `expects it at this exact path in the shipped tarball.`,
      ).toBe(true);
      const { size } = fs.statSync(abs);
      expect(size, `${abs} is empty (0 bytes)`).toBeGreaterThan(0);
    });
  }

  it('JSON schema asset parses as JSON', () => {
    const schemaPath = path.join(DIST, 'policy', 'schema', 'v0.2.json');
    const raw = fs.readFileSync(schemaPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
