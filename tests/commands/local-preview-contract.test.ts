import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'switchbot-preview-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function cliWithInput(args: string[], input?: string) {
  const res = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', '--json', ...args], {
    encoding: 'utf8', timeout: 15_000, input,
    env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, PATH: process.env.PATH,
      SWITCHBOT_TOKEN: 'local-fixture', SWITCHBOT_SECRET: 'local-fixture', NO_COLOR: '1' },
  });
  if (res.error) throw res.error;
  if (!res.stdout) throw new Error(`No CLI response (${res.status}): ${res.stderr}`);
  return { code: res.status, ...JSON.parse(res.stdout) };
}
const cli = (...args: string[]) => cliWithInput(args);

it('previews policy changes even when Commander consumed the global flag', () => {
  const file = join(home, 'policy.yaml');
  const original = 'version: "0.2"\naliases:\n  lamp: "28372F4C9C4C"\nautomation:\n  enabled: false\n  rules: []\n';
  writeFileSync(file, original);
  const rule = 'name: sample\nwhen:\n  source: cron\n  schedule: "0 9 * * *"\nthen:\n  - command: "devices command <id> turnOn"\n    device: lamp\ndry_run: true\n';
  const result = cliWithInput(['--dry-run', 'policy', 'add-rule', '--policy', file], rule);
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(result).toMatchObject({ code: 0, data: { written: false, ruleName: 'sample' } });
});

it('refuses unsupported local previews before approving a plan or modifying an alias', () => {
  const file = join(home, 'wait.json');
  writeFileSync(file, JSON.stringify({ version: '1.0', steps: [{ type: 'wait', ms: 1 }] }));
  const { planId } = cli('plan', 'save', file).data;
  const approval = cli('--dry-run', 'plan', 'approve', planId);
  expect(cli('plan', 'review', planId).data.status).toBe('pending');
  expect(approval).toMatchObject({ code: 2, error: { kind: 'usage' } });
  const meta = cli('devices', 'meta', 'set', 'fixture', '--alias', 'nothing-written', '--dry-run');
  expect(cli('devices', 'meta', 'get', 'fixture').data.meta).toBeNull();
  expect(meta).toMatchObject({ code: 2, error: { kind: 'usage' } });
  const { commandMeta } = cli('capabilities', '--compact', '--project', 'commandMeta').data;
  expect(commandMeta['plan approve'].supportsDryRun).toBe(false);
  expect(commandMeta['devices meta set'].supportsDryRun).toBe(false);
  expect(commandMeta['plan execute'].supportsDryRun).toBe(true);
}, 30_000);
