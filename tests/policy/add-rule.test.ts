import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addRuleToPolicySource, addRuleToPolicyFile, AddRuleError } from '../../src/policy/add-rule.js';

const MINIMAL_POLICY_V02 = `version: "0.2"
aliases:
  lamp-1: "28372F4C9C4C"
automation:
  enabled: false
  rules: []
`;

const POLICY_WITH_RULE = `version: "0.2"
aliases:
  lamp-1: "28372F4C9C4C"
automation:
  enabled: true
  rules:
    - name: "existing rule"
      when:
        source: cron
        schedule: "0 8 * * *"
      then:
        - command: "devices command <id> turnOn"
          device: "lamp-1"
      dry_run: true
`;

const POLICY_NO_AUTOMATION = `version: "0.2"
aliases:
  lamp-1: "28372F4C9C4C"
`;

const SIMPLE_RULE_YAML = `name: "test rule"
when:
  source: cron
  schedule: "0 9 * * *"
then:
  - command: "devices command <id> turnOn"
    device: "lamp-1"
dry_run: true
`;

let tmpDir: string;
let policyPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'add-rule-test-'));
  policyPath = path.join(tmpDir, 'policy.yaml');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('addRuleToPolicySource', () => {
  it('appends a rule to an existing empty rules list', () => {
    fs.writeFileSync(policyPath, MINIMAL_POLICY_V02, 'utf8');
    const { ruleName, nextSource } = addRuleToPolicySource({
      ruleYaml: SIMPLE_RULE_YAML,
      policyPath,
    });
    expect(ruleName).toBe('test rule');
    expect(nextSource).toContain('test rule');
    expect(nextSource).toContain('0 9 * * *');
  });

  it('appends without overwriting existing rules', () => {
    fs.writeFileSync(policyPath, POLICY_WITH_RULE, 'utf8');
    const { nextSource } = addRuleToPolicySource({
      ruleYaml: SIMPLE_RULE_YAML,
      policyPath,
    });
    expect(nextSource).toContain('existing rule');
    expect(nextSource).toContain('test rule');
  });

  it('creates automation block when absent', () => {
    fs.writeFileSync(policyPath, POLICY_NO_AUTOMATION, 'utf8');
    const { nextSource } = addRuleToPolicySource({
      ruleYaml: SIMPLE_RULE_YAML,
      policyPath,
    });
    expect(nextSource).toContain('automation:');
    expect(nextSource).toContain('test rule');
  });

  it('sets automation.enabled when --enable is passed', () => {
    fs.writeFileSync(policyPath, MINIMAL_POLICY_V02, 'utf8');
    const { nextSource } = addRuleToPolicySource({
      ruleYaml: SIMPLE_RULE_YAML,
      policyPath,
      enableAutomation: true,
    });
    expect(nextSource).toContain('enabled: true');
  });

  it('throws on duplicate rule name without --force', () => {
    fs.writeFileSync(policyPath, POLICY_WITH_RULE, 'utf8');
    const dupRule = `name: "existing rule"\nwhen:\n  source: cron\n  schedule: "0 7 * * *"\nthen:\n  - command: "devices command <id> turnOff"\n    device: "lamp-1"\ndry_run: true\n`;
    expect(() =>
      addRuleToPolicySource({ ruleYaml: dupRule, policyPath }),
    ).toThrowError(AddRuleError);
    expect(() =>
      addRuleToPolicySource({ ruleYaml: dupRule, policyPath }),
    ).toThrowError(/already exists/);
  });

  it('overwrites duplicate rule name with --force', () => {
    fs.writeFileSync(policyPath, POLICY_WITH_RULE, 'utf8');
    const dupRule = `name: "existing rule"\nwhen:\n  source: cron\n  schedule: "0 7 * * *"\nthen:\n  - command: "devices command <id> turnOff"\n    device: "lamp-1"\ndry_run: true\n`;
    const { nextSource } = addRuleToPolicySource({
      ruleYaml: dupRule,
      policyPath,
      force: true,
    });
    expect(nextSource).toContain('0 7 * * *');
    // Original schedule should be gone
    expect(nextSource).not.toContain('0 8 * * *');
  });

  it('throws on invalid rule YAML', () => {
    fs.writeFileSync(policyPath, MINIMAL_POLICY_V02, 'utf8');
    expect(() =>
      addRuleToPolicySource({ ruleYaml: ': bad yaml :::', policyPath }),
    ).toThrowError(AddRuleError);
  });

  it('throws when rule has no name', () => {
    fs.writeFileSync(policyPath, MINIMAL_POLICY_V02, 'utf8');
    expect(() =>
      addRuleToPolicySource({ ruleYaml: 'when:\n  source: cron\n  schedule: "0 8 * * *"\nthen:\n  - command: test\n', policyPath }),
    ).toThrowError(/name/);
  });

  it('includes diff in the result', () => {
    fs.writeFileSync(policyPath, MINIMAL_POLICY_V02, 'utf8');
    const { diff } = addRuleToPolicySource({ ruleYaml: SIMPLE_RULE_YAML, policyPath });
    expect(diff).toContain('+');
    expect(diff).toContain('test rule');
  });
});

describe('addRuleToPolicyFile', () => {
  it('writes the file when dry_run is false', () => {
    fs.writeFileSync(policyPath, MINIMAL_POLICY_V02, 'utf8');
    const { written } = addRuleToPolicyFile({ ruleYaml: SIMPLE_RULE_YAML, policyPath });
    expect(written).toBe(true);
    const contents = fs.readFileSync(policyPath, 'utf8');
    expect(contents).toContain('test rule');
  });

  it('does not write the file when dryRun is true', () => {
    fs.writeFileSync(policyPath, MINIMAL_POLICY_V02, 'utf8');
    const { written } = addRuleToPolicyFile({
      ruleYaml: SIMPLE_RULE_YAML,
      policyPath,
      dryRun: true,
    });
    expect(written).toBe(false);
    const contents = fs.readFileSync(policyPath, 'utf8');
    expect(contents).toBe(MINIMAL_POLICY_V02);
  });
});
