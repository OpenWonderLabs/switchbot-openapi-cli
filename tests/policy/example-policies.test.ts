import { expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePolicyFile } from '../../src/policy/validate.js';

it('accepts the copied cautious first-day policy without requiring a legacy CLI', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'switchbot-first-day-policy-'));
  const installed = path.join(home, 'policy.yaml');
  try {
    copyFileSync('examples/policies/cautious.yaml', installed);
    const result = validatePolicyFile(installed);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    expect(result.errors).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
