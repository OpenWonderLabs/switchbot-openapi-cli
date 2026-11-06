import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadPolicyFile } from '../../src/policy/load.js';
import { validateLoadedPolicyAgainstInventory } from '../../src/policy/validate.js';

describe('Solar Pan/Tilt Cam safety policy', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    ['Solar Pan/Tilt Cam 2K', false],
    ['Video Doorbell', true],
  ] as const)('validates disableMotionDetection against %s rather than globally banning the verb', (deviceType, allowed) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-camera-policy-'));
    const policyPath = path.join(tmpDir, 'policy.yaml');
    fs.writeFileSync(policyPath, [
      'version: "0.2"',
      'confirmations:',
      '  never_confirm: [disableMotionDetection]',
      'aliases:',
      '  camera: 01-202407090924-26354212',
      'automation:',
      '  rules:',
      '    - name: camera motion',
      '      when: { source: mqtt, event: x.y }',
      '      then:',
      '        - command: devices command <id> disableMotionDetection',
      '          device: camera',
    ].join('\n'));
    const result = validateLoadedPolicyAgainstInventory(loadPolicyFile(policyPath), {
      deviceList: [{
        deviceId: '01-202407090924-26354212', deviceName: 'Camera', deviceType,
        enableCloudService: true, hubDeviceId: '',
      }],
      infraredRemoteList: [],
    });
    expect(result.valid).toBe(allowed);
    if (!allowed) expect(result.errors).toContainEqual(expect.objectContaining({
      keyword: 'rule-destructive-action', path: '/automation/rules/0/then/0/command',
    }));
  });
});
