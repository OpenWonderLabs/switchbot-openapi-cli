/**
 * Policy schema validation — unit tests.
 *
 * Drives `validateLoadedPolicy` against a matrix of real-looking YAML
 * documents and asserts:
 *   - valid fixtures pass with no errors
 *   - invalid fixtures surface the expected `keyword` (ajv) at the
 *     expected instancePath
 *   - destructive actions cannot be pre-approved in `never_confirm`
 *     (the skill's primary safety invariant)
 *   - quiet_hours uses `dependentRequired` so partial configs fail
 *
 * We load through `loadPolicyFile` because the validator consumes the
 * full `LoadedPolicy` envelope (data + doc + source), and we want the
 * tests to exercise the same path production uses.
 *
 * NOTE (v3.0): v0.1 policy support was removed. All v0.1 fixtures now
 * return { valid: false, errors: [{ keyword: 'unsupported-version' }] }.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadPolicyFile } from '../../src/policy/load.js';
import { validateLoadedPolicy, validateLoadedPolicyAgainstInventory } from '../../src/policy/validate.js';

function writeAndLoad(tmpDir: string, yaml: string) {
  const p = path.join(tmpDir, 'policy.yaml');
  fs.writeFileSync(p, yaml, 'utf-8');
  return loadPolicyFile(p);
}

describe('policy validator (v0.1 — unsupported in v3.0)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-policy-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // All v0.1 documents are now rejected with a single unsupported-version error.

  it('rejects a minimal v0.1 policy with unsupported-version', () => {
    const loaded = writeAndLoad(tmpDir, 'version: "0.1"\n');
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const vErr = result.errors.find((e) => e.keyword === 'unsupported-version');
    expect(vErr).toBeDefined();
    expect(vErr!.path).toBe('/version');
    expect(vErr!.hint).toMatch(/v3\.0|supported version/i);
  });

  it('rejects nulls-on-every-block v0.1 policy with unsupported-version', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.1"',
        'aliases:',
        'confirmations:',
        'quiet_hours:',
        'audit:',
        'automation:',
        'cli:',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
  });

  it.each([
    ['aliases'],
    ['confirmations'],
    ['quiet_hours'],
    ['audit'],
    ['automation'],
    ['cli'],
  ])('rejects v0.1 with null %s block (unsupported-version)', (block) => {
    const loaded = writeAndLoad(tmpDir, `version: "0.1"\n${block}:\n`);
    const result = validateLoadedPolicy(loaded);
    expect(result.valid, `v0.1 ${block}:null should be unsupported`).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
  });

  it('flags a missing version field with a clear hint (falls back to current schema)', () => {
    const loaded = writeAndLoad(tmpDir, 'aliases:\n  "lamp": "01-ABC-12345"\n');
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const missing = result.errors.find((e) => e.keyword === 'required');
    expect(missing).toBeDefined();
    expect(missing!.message).toContain('version');
    expect(missing!.hint).toContain('0.2');
  });

  it('rejects an unsupported schema version "0.9" with a helpful hint', () => {
    // "0.9" is not in SUPPORTED_POLICY_SCHEMA_VERSIONS — the validator short-
    // circuits before dispatching to a schema and returns a single
    // unsupported-version error.
    const loaded = writeAndLoad(tmpDir, 'version: "0.9"\n');
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const versionErr = result.errors.find((e) => e.keyword === 'unsupported-version');
    expect(versionErr).toBeDefined();
    expect(versionErr!.path).toBe('/version');
    expect(versionErr!.hint).toMatch(/supported versions/i);
  });

  it('rejects v0.1 with an unknown top-level key (unsupported-version short-circuits)', () => {
    const loaded = writeAndLoad(tmpDir, 'version: "0.1"\nbogus: 1\n');
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    // unsupported-version fires before additionalProperties check
    expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
  });

  it('rejects v0.1 aliases with canonical deviceId format (unsupported-version)', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.1"',
        'aliases:',
        '  "living room light": "01-202407090924-26354212"',
        '  "bedroom AC":        "02-202502111234-85411230"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
  });

  it('rejects v0.1 with lowercased deviceIds (unsupported-version short-circuits)', () => {
    const loaded = writeAndLoad(
      tmpDir,
      ['version: "0.1"', 'aliases:', '  "lamp": "not-a-device-id"', ''].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    // unsupported-version fires first; no pattern error expected
    expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
  });

  for (const destructive of ['lock', 'unlock', 'deleteWebhook', 'deleteScene', 'factoryReset']) {
    it(`rejects v0.1 with "${destructive}" in never_confirm (unsupported-version)`, () => {
      const loaded = writeAndLoad(
        tmpDir,
        [
          'version: "0.1"',
          'confirmations:',
          '  never_confirm:',
          `    - "${destructive}"`,
          '',
        ].join('\n'),
      );
      const result = validateLoadedPolicy(loaded);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
    });
  }

  it('rejects v0.1 non-destructive never_confirm (unsupported-version)', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.1"',
        'confirmations:',
        '  never_confirm:',
        '    - "turnOn"',
        '    - "turnOff"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
  });

  it('rejects v0.1 well-formed quiet_hours (unsupported-version)', () => {
    const loaded = writeAndLoad(
      tmpDir,
      ['version: "0.1"', 'quiet_hours:', '  start: "22:00"', '  end:   "08:00"', ''].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
  });

  it('rejects v0.1 out-of-range hours (unsupported-version short-circuits)', () => {
    const loaded = writeAndLoad(
      tmpDir,
      ['version: "0.1"', 'quiet_hours:', '  start: "25:00"', '  end:   "08:00"', ''].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
  });

  it('rejects v0.1 quiet_hours with only `start` (unsupported-version)', () => {
    const loaded = writeAndLoad(
      tmpDir,
      ['version: "0.1"', 'quiet_hours:', '  start: "22:00"', ''].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
  });

  it('rejects v0.1 quiet_hours with only `end` (unsupported-version)', () => {
    const loaded = writeAndLoad(
      tmpDir,
      ['version: "0.1"', 'quiet_hours:', '  end: "08:00"', ''].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
  });

  it('rejects v0.1 audit.retention values (unsupported-version)', () => {
    for (const retention of ['never', '90d', '4w', '6m']) {
      const loaded = writeAndLoad(
        tmpDir,
        ['version: "0.1"', 'audit:', `  retention: "${retention}"`, ''].join('\n'),
      );
      const result = validateLoadedPolicy(loaded);
      expect(result.valid, `v0.1 retention=${retention} should be unsupported`).toBe(false);
      expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
    }
  });

  it('rejects v0.1 audit.retention without unit suffix (unsupported-version)', () => {
    const loaded = writeAndLoad(
      tmpDir,
      ['version: "0.1"', 'audit:', '  retention: "10"', ''].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
  });

  it('rejects v0.1 cli.cache_ttl values (unsupported-version)', () => {
    for (const ttl of ['30s', '5m', '2h']) {
      const loaded = writeAndLoad(
        tmpDir,
        ['version: "0.1"', 'cli:', `  cache_ttl: "${ttl}"`, ''].join('\n'),
      );
      const result = validateLoadedPolicy(loaded);
      expect(result.valid, `v0.1 cache_ttl=${ttl} should be unsupported`).toBe(false);
      expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
    }
  });

  it('rejects v0.1 with bad alias value (unsupported-version, no line info expected)', () => {
    const loaded = writeAndLoad(
      tmpDir,
      ['version: "0.1"', 'aliases:', '  "lamp": "lowercase-bad"', ''].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
  });
});

describe('policy validator (v0.2)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-policy-v02-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts a minimal v0.2 policy with only the version field', () => {
    const loaded = writeAndLoad(tmpDir, 'version: "0.2"\n');
    const result = validateLoadedPolicy(loaded);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    expect(result.schemaVersion).toBe('0.2');
  });

  it('accepts a v0.2 policy with a well-formed MQTT rule', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'automation:',
        '  enabled: true',
        '  rules:',
        '    - name: "motion at night"',
        '      when:',
        '        source: mqtt',
        '        event: motion.detected',
        '      conditions:',
        '        - time_between: ["22:00", "06:00"]',
        '      then:',
        '        - command: "devices command <id> turnOn"',
        '          device: "hallway-light"',
        '      throttle:',
        '        max_per: "10m"',
        '      dry_run: true',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    expect(result.schemaVersion).toBe('0.2');
  });

  it('rejects a rule missing the required `when` trigger', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'automation:',
        '  rules:',
        '    - name: "incomplete"',
        '      then:',
        '        - command: "devices command <id> turnOn"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const req = result.errors.find(
      (e) => e.keyword === 'required' && e.message.includes('when'),
    );
    expect(req).toBeDefined();
  });

  it('falls back to current-schema validation when version is missing', () => {
    // Declared version is undefined → dispatch to CURRENT (0.2). The resulting
    // error is the v0.2 "required: version" gate, not an unsupported-version
    // short-circuit.
    const loaded = writeAndLoad(tmpDir, 'aliases:\n  "lamp": "01-ABC-12345"\n');
    const result = validateLoadedPolicy(loaded);
    expect(result.schemaVersion).toBe('0.2');
    expect(result.valid).toBe(false);
    const req = result.errors.find((e) => e.keyword === 'required');
    expect(req).toBeDefined();
    expect(req!.message).toContain('version');
  });

  it('returns unsupported-version (does not throw) for a future version', () => {
    const loaded = writeAndLoad(tmpDir, 'version: "0.3"\n');
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].keyword).toBe('unsupported-version');
    expect(result.errors[0].message).toContain('0.3');
  });

  it('rejects destructive verbs inside automation.rules[].then[].command', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'automation:',
        '  rules:',
        '    - name: "unlock on arrival"',
        '      when:',
        '        source: mqtt',
        '        event: presence.home',
        '      then:',
        '        - command: "devices command <id> unlock"',
        '          device: "front-door-lock"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const ruleErr = result.errors.find((e) => e.keyword === 'rule-destructive-action');
    expect(ruleErr).toBeDefined();
    expect(ruleErr!.message).toContain('unlock');
    expect(ruleErr!.path).toBe('/automation/rules/0/then/0/command');
    expect(ruleErr!.hint).toMatch(/confirmation gate/);
  });

  it.each([
    'devices command <id> lock',
    'devices command <id> factoryReset',
    'webhooks delete <id>',
    'scenes delete <id>',
  ])('flags destructive command shape %s', (cmd) => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'automation:',
        '  rules:',
        '    - name: "bad rule"',
        '      when:',
        '        source: mqtt',
        '        event: x.y',
        '      then:',
        `        - command: "${cmd}"`,
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'rule-destructive-action')).toBe(true);
  });

  it('allows non-destructive verbs like turnOn / setMode', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'automation:',
        '  rules:',
        '    - name: "nightlight"',
        '      when:',
        '        source: mqtt',
        '        event: motion.detected',
        '      then:',
        '        - command: "devices command <id> turnOn"',
        '          device: "hall-light"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('rejects alias targets that do not look like SwitchBot deviceIds', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'aliases:',
        '  lamp: abc_def',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.keyword === 'alias-device-id');
    expect(err).toBeDefined();
    expect(err!.path).toBe('/aliases/lamp');
  });

  it('rejects unparseable automation command strings before runtime', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'automation:',
        '  rules:',
        '    - name: "bad shape"',
        '      when:',
        '        source: mqtt',
        '        event: x.y',
        '      then:',
        '        - command: "scenes run bedtime"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.keyword === 'rule-unparseable-command');
    expect(err).toBeDefined();
    expect(err!.path).toBe('/automation/rules/0/then/0/command');
  });

  it('rejects unknown device verbs even when the command shape parses', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'aliases:',
        '  hall-light: 01-202407090924-26354212',
        'automation:',
        '  rules:',
        '    - name: "bad verb"',
        '      when:',
        '        source: mqtt',
        '        event: x.y',
        '      then:',
        '        - command: "devices command <id> frobnicate"',
        '          device: hall-light',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.keyword === 'rule-unknown-command');
    expect(err).toBeDefined();
    expect(err!.path).toBe('/automation/rules/0/then/0/command');
  });

  it('rejects <id> placeholders that omit device resolution', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'automation:',
        '  rules:',
        '    - name: "missing device"',
        '      when:',
        '        source: mqtt',
        '        event: x.y',
        '      then:',
        '        - command: "devices command <id> turnOn"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.keyword === 'missing-device');
    expect(err).toBeDefined();
    expect(err!.path).toBe('/automation/rules/0/then/0/command');
  });

  it('accepts alias references embedded directly in the command slot', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'aliases:',
        '  hall-light: 01-202407090924-26354212',
        'automation:',
        '  rules:',
        '    - name: "slot alias"',
        '      when:',
        '        source: mqtt',
        '        event: x.y',
        '      then:',
        '        - command: "devices command hall-light turnOn"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('live inventory validation rejects aliases that do not exist on the account', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'aliases:',
        '  hall-light: 01-202407090924-26354212',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicyAgainstInventory(loaded, {
      deviceList: [],
      infraredRemoteList: [],
    });
    expect(result.valid).toBe(false);
    expect(result.validationScope).toBe('schema+offline-semantics+live-inventory');
    const err = result.errors.find((e) => e.keyword === 'alias-live-device-not-found');
    expect(err).toBeDefined();
    expect(err!.path).toBe('/aliases/hall-light');
  });

  it('live inventory validation rejects commands unsupported by the resolved real device type', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'aliases:',
        '  room-sensor: 01-202407090924-26354212',
        'automation:',
        '  rules:',
        '    - name: "bad live target"',
        '      when:',
        '        source: mqtt',
        '        event: x.y',
        '      then:',
        '        - command: "devices command <id> turnOn"',
        '          device: room-sensor',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicyAgainstInventory(loaded, {
      deviceList: [
        {
          deviceId: '01-202407090924-26354212',
          deviceName: 'Bedroom Meter',
          deviceType: 'Meter',
          enableCloudService: true,
          hubDeviceId: '',
        },
      ],
      infraredRemoteList: [],
    });
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.keyword === 'rule-live-unsupported-command');
    expect(err).toBeDefined();
    expect(err!.path).toBe('/automation/rules/0/then/0/command');
  });
});
