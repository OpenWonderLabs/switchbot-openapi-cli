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

  it('rejects unknown mqtt trigger device refs during offline validation', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'automation:',
        '  rules:',
        '    - name: "bad trigger ref"',
        '      when:',
        '        source: mqtt',
        '        event: motion.detected',
        '        device: kitchen sesnor',
        '      then:',
        '        - command: "devices command hall-light turnOn"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.path === '/automation/rules/0/when/device');
    expect(err).toBeDefined();
    expect(err!.message).toContain('trigger references unknown device');
  });

  it('rejects unknown device_state refs during offline validation', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'aliases:',
        '  hall-light: 01-202407090924-26354212',
        'automation:',
        '  rules:',
        '    - name: "bad condition ref"',
        '      when:',
        '        source: mqtt',
        '        event: motion.detected',
        '      conditions:',
        '        - device: old sensor',
        '          field: temperature',
        '          op: ">="',
        '          value: 20',
        '      then:',
        '        - command: "devices command hall-light turnOn"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.path === '/automation/rules/0/conditions/0/device');
    expect(err).toBeDefined();
    expect(err!.message).toContain('condition references unknown device');
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

  it('live inventory validation rejects stale mqtt trigger device refs', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'aliases:',
        '  hall-sensor: 01-202407090924-26354212',
        '  hall-light: 01-202407090924-26354213',
        'automation:',
        '  rules:',
        '    - name: "stale trigger ref"',
        '      when:',
        '        source: mqtt',
        '        event: motion.detected',
        '        device: hall-sensor',
        '      then:',
        '        - command: "devices command hall-light turnOn"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicyAgainstInventory(loaded, {
      deviceList: [
        {
          deviceId: '01-202407090924-26354213',
          deviceName: 'Hall Light',
          deviceType: 'Bot',
          enableCloudService: true,
          hubDeviceId: '',
        },
      ],
      infraredRemoteList: [],
    });
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.path === '/automation/rules/0/when/device');
    expect(err).toBeDefined();
    expect(err!.keyword).toBe('rule-live-device-not-found');
  });

  it('live inventory validation rejects stale condition device refs', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'aliases:',
        '  climate-sensor: 01-202407090924-26354212',
        '  hall-light: 01-202407090924-26354213',
        'automation:',
        '  rules:',
        '    - name: "stale condition ref"',
        '      when:',
        '        source: mqtt',
        '        event: motion.detected',
        '      conditions:',
        '        - device: climate-sensor',
        '          field: temperature',
        '          op: ">="',
        '          value: 20',
        '      then:',
        '        - command: "devices command hall-light turnOn"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicyAgainstInventory(loaded, {
      deviceList: [
        {
          deviceId: '01-202407090924-26354213',
          deviceName: 'Hall Light',
          deviceType: 'Bot',
          enableCloudService: true,
          hubDeviceId: '',
        },
      ],
      infraredRemoteList: [],
    });
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.path === '/automation/rules/0/conditions/0/device');
    expect(err).toBeDefined();
    expect(err!.keyword).toBe('rule-live-device-not-found');
  });

  // Contract guard for the C-1 concern from the 3.3.1 review.
  //
  // `validateLoadedPolicyAgainstInventory` skips rules whose effective
  // device ref is undefined, empty, or the literal `<id>` placeholder
  // (via `resolveInventoryDeviceId` → null → `continue`). That is only
  // safe because the offline base pass (`validateLoadedPolicy`) is
  // expected to catch those same pathological refs first.
  //
  // This test pins the coupling: if any future edit weakens the offline
  // catch for these shapes, the live path will silently accept a broken
  // rule at validation time and the rule will blow up at execution time.
  // Keep BOTH passes true — the live validator must never be the sole
  // defender of these cases.
  it.each([
    {
      label: 'rule with `<id>` slot but no `device:` field',
      command: 'devices command <id> turnOn',
      deviceField: undefined as string | undefined,
    },
    {
      label: 'rule with empty string in `device:`',
      command: 'devices command <id> turnOn',
      deviceField: '',
    },
    {
      label: 'rule with literal `<id>` in `device:`',
      command: 'devices command <id> turnOn',
      deviceField: '<id>',
    },
  ])(
    'live inventory validation — offline pass catches pathological device ref ($label)',
    ({ command, deviceField }) => {
      const action =
        deviceField === undefined
          ? `        - command: "${command}"`
          : [
              `        - command: "${command}"`,
              `          device: ${JSON.stringify(deviceField)}`,
            ].join('\n');
      const loaded = writeAndLoad(
        tmpDir,
        [
          'version: "0.2"',
          'automation:',
          '  rules:',
          '    - name: "pathological ref"',
          '      when:',
          '        source: mqtt',
          '        event: x.y',
          '      then:',
          action,
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
      // The rule must not silently pass. Either the offline `missing-device`
      // / `unknown-device-ref` keyword fires, or a dedicated live keyword
      // does — but SOMETHING must error on this rule's action path.
      expect(result.valid).toBe(false);
      const ruleActionErrs = result.errors.filter((e) =>
        e.path.startsWith('/automation/rules/0/then/0/'),
      );
      expect(
        ruleActionErrs.length,
        `expected at least one error on the rule action, got none. errors:\n${JSON.stringify(result.errors, null, 2)}`,
      ).toBeGreaterThan(0);
    },
  );
});

describe('policy validator — notify action (v0.2 schema extension)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-policy-notify-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts a rule with a valid notify action (webhook channel)', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'automation:',
        '  enabled: true',
        '  rules:',
        '    - name: "alert on motion"',
        '      when:',
        '        source: cron',
        '        schedule: "0 8 * * *"',
        '      then:',
        '        - type: notify',
        '          channel: webhook',
        '          to: "https://example.com/hook"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a rule with a valid notify action (file channel)', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'automation:',
        '  enabled: true',
        '  rules:',
        '    - name: "log motion"',
        '      when:',
        '        source: mqtt',
        '        event: motion.detected',
        '      then:',
        '        - type: notify',
        '          channel: file',
        '          to: "/tmp/sb-events.jsonl"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a rule mixing command and notify actions', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'automation:',
        '  enabled: true',
        '  rules:',
        '    - name: "turn on then notify"',
        '      when:',
        '        source: cron',
        '        schedule: "0 8 * * *"',
        '      then:',
        '        - command: "devices command 01-202407090924-26354212 turnOn"',
        '        - type: notify',
        '          channel: webhook',
        '          to: "https://example.com/hook"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects a notify action with an unknown channel', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'automation:',
        '  enabled: true',
        '  rules:',
        '    - name: "bad channel"',
        '      when:',
        '        source: cron',
        '        schedule: "0 8 * * *"',
        '      then:',
        '        - type: notify',
        '          channel: fax',
        '          to: "https://example.com"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
  });

  it('rejects a notify action with missing required "to" field', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'automation:',
        '  enabled: true',
        '  rules:',
        '    - name: "missing to"',
        '      when:',
        '        source: cron',
        '        schedule: "0 8 * * *"',
        '      then:',
        '        - type: notify',
        '          channel: webhook',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
  });

  it('existing command actions still validate without type field', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.2"',
        'automation:',
        '  enabled: true',
        '  rules:',
        '    - name: "legacy command action"',
        '      when:',
        '        source: cron',
        '        schedule: "0 8 * * *"',
        '      then:',
        '        - command: "devices command 01-202407090924-26354212 turnOn"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
