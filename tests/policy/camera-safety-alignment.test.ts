import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadPolicyFile } from '../../src/policy/load.js';
import { validateLoadedPolicy } from '../../src/policy/validate.js';

describe('Solar Pan/Tilt Cam safety policy', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects disableMotionDetection in confirmations.never_confirm', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-camera-policy-'));
    const policyPath = path.join(tmpDir, 'policy.yaml');
    fs.writeFileSync(
      policyPath,
      ['version: "0.2"', 'confirmations:', '  never_confirm:', '    - disableMotionDetection', ''].join('\n'),
      'utf-8',
    );

    const result = validateLoadedPolicy(loadPolicyFile(policyPath));

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ keyword: 'not', path: '/confirmations/never_confirm/0' }),
    );
  });
});
