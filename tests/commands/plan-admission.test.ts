import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

const id = '00000000-0000-4000-8000-000000000001';
let home: string;
let dir: string;
let credentials: Record<string, string>;
beforeEach(() => {
  credentials = { SWITCHBOT_TOKEN: 'fixture', SWITCHBOT_SECRET: 'fixture' };
  home = mkdtempSync(join(tmpdir(), 'plan-admission-'));
  dir = join(home, '.switchbot', 'plans');
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function seed(steps: unknown[]) {
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ planId: id, status: 'approved',
    createdAt: '2024-01-01T00:00:00Z', credentialScope: { kind: 'profile', profile: 'default' },
    plan: { version: '1.0', steps } }));
}

// Exercise independent source CLI processes on the same disk record. No real transport is reachable.
const harness = `
  import axios from 'axios';
  import fs from 'node:fs';
  import { spawnSync } from 'node:child_process';
  const runner = process.execArgv;
  if (process.env.MODE === 'replace-before-signing') {
    const create = axios.create.bind(axios);
    axios.create = (...args) => {
      const client = create(...args);
      const post = client.post.bind(client);
      client.post = (...args) => {
        process.env.SWITCHBOT_TOKEN = 'replacement-before-signing';
        return post(...args);
      };
      return client;
    };
  }
  axios.defaults.adapter = async config => {
    fs.appendFileSync(process.env.HOME + '/dispatch', config.url + '\\n');
    if (process.env.MODE === 'crash') {
      const other = spawnSync(process.execPath, runner, { encoding: 'utf8', timeout: 10000,
        env: { ...process.env, MODE: '' } });
      fs.writeFileSync(process.env.HOME + '/contender', other.stdout);
      process.exit(86); // cloud accepted the action, but the client never received a response
    }
    const offline = process.env.MODE === 'offline' && config.url.includes('/B/');
    if (process.env.MODE === 'timeout' && config.url.includes('/B/')) throw new Error('response lost');
    const body = config.url === '/v1.1/devices' ? {
      deviceList: [{ deviceId: 'PLUG1', deviceName: 'Test outlet', deviceType: 'Plug Mini (US)' }], infraredRemoteList: [],
    } : {};
    return { config, status: 200, statusText: 'OK', headers: {}, data: { statusCode: offline ? 161 : 100, body } };
  };
  process.argv = ['node', 'switchbot', '--json', '--no-quota', ...JSON.parse(process.env.ARGS)];
  // Commander otherwise parses eval argv; load the entrypoint only after installing the adapter.
  process.execArgv = [];
  await import('./src/index.ts');
`;
function cli(mode: string, ...args: string[]) {
  const res = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', harness], {
    timeout: 20000, encoding: 'utf8',
    env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, PATH: process.env.PATH,
      ...credentials, MODE: mode, ARGS: JSON.stringify(args) },
  });
  if (res.error) throw res.error;
  return { status: res.status, body: res.stdout ? JSON.parse(res.stdout) : null, stderr: res.stderr };
}
const calls = () => readFileSync(join(home, 'dispatch'), 'utf8').trim().split('\n');

it('admits only one executor before dispatch and fails closed after an interrupted scene', () => {
  seed([{ type: 'scene', sceneId: 'A' }]);
  expect(cli('', 'plan', 'approve', id).status).toBe(0);
  const interrupted = cli('crash', 'plan', 'execute', id);
  expect(interrupted.status, JSON.stringify(interrupted)).toBe(86);
  expect(JSON.parse(readFileSync(join(home, 'contender'), 'utf8')).error).toBeDefined();
  expect(cli('', 'plan', 'execute', id).body.error).toBeDefined();
  expect(calls()).toEqual(['/v1.1/scenes/A/execute']);
}, 30000);

it('previews approved empty and wait-only plans without changing the record or taking a claim', () => {
  for (const steps of [[], [{ type: 'wait', ms: 10000 }]]) {
    seed(steps);
    const original = readFileSync(join(dir, `${id}.json`), 'utf8');
    expect(cli('', '--dry-run', 'plan', 'execute', id).body.data).toMatchObject({ ran: false, succeeded: true });
    expect(readFileSync(join(dir, `${id}.json`), 'utf8')).toBe(original);
    expect(readdirSync(dir)).toEqual([`${id}.json`]);
  }
}, 30000);

it.each(['offline', 'timeout'])('does not repeat completed steps on reapproval after %s', mode => {
  seed(['A', 'B'].map(sceneId => ({ type: 'scene', sceneId })));
  expect(cli('', 'plan', 'approve', id).status).toBe(0);
  const first = cli(mode, 'plan', 'execute', id);
  expect(first.status, JSON.stringify(first)).toBe(1);
  expect(first.body.data.results.map((r: { status: string }) => r.status)).toEqual(['ok', 'error']);
  const approval = cli('', 'plan', 'approve', id);
  if (mode === 'offline') expect(approval.status).toBe(0);
  const retry = cli('', 'plan', 'execute', id);
  if (mode === 'offline') {
    expect(retry.status).toBe(0);
    expect(retry.body.data.summary.ok).toBe(2);
    expect(calls()).toEqual(['/v1.1/scenes/A/execute', '/v1.1/scenes/B/execute', '/v1.1/scenes/B/execute']);
  } else {
    expect(retry.status).not.toBe(0);
    expect(calls()).toEqual(['/v1.1/scenes/A/execute', '/v1.1/scenes/B/execute']);
  }
  const reviewed = cli('', 'plan', 'review', id).body.data;
  expect(Object.keys(reviewed).sort()).toEqual(
    ['planId', 'status', 'createdAt', 'credentialScope', 'plan', 'failedAt', 'failureReason',
      'approvedAt', ...(mode === 'offline' ? ['executedAt'] : [])].sort(),
  );
}, 30000);

it('refuses reapproval of a failed legacy record without evidence of which steps ran', () => {
  seed([{ type: 'scene', sceneId: 'A' }]);
  const file = join(dir, `${id}.json`);
  const failed = { ...JSON.parse(readFileSync(file, 'utf8')), status: 'failed' };
  writeFileSync(file, JSON.stringify(failed));
  expect(cli('', 'plan', 'approve', id).body.error).toMatchObject({ kind: 'guard' });
  expect(cli('', 'plan', 'review', id).body.data).toEqual(failed);
  expect(readdirSync(dir)).toEqual([`${id}.json`]);
}, 30000);

it('invalidates the saved approval when credentials are replaced under the same selector', () => {
  const file = join(home, 'source.json');
  writeFileSync(file, JSON.stringify({ version: '1.0', steps: [{ type: 'wait', ms: 0 }] }));
  const revisionFile = join(home, '.switchbot', '.credential-revision');
  writeFileSync(revisionFile, 'first-fixture-revision');
  const savedId = cli('', 'plan', 'save', file).body.data.planId;
  expect(cli('', 'plan', 'approve', savedId).status).toBe(0);
  writeFileSync(revisionFile, 'replacement-fixture-revision');
  expect(cli('', 'plan', 'execute', savedId).body.error).toMatchObject({ kind: 'guard' });
  expect(cli('', 'plan', 'approve', savedId).body.error).toMatchObject({ kind: 'guard' });
  const reviewed = cli('', 'plan', 'review', savedId).body.data;
  expect(reviewed.credentialScope).toEqual({ kind: 'profile', profile: 'default' });
  expect(JSON.stringify(reviewed)).not.toContain('fixture-revision');
}, 30000);

it.each(['env', 'config'])('prevents unannounced %s credential replacement from inheriting approval', source => {
  const planFile = join(home, 'source.json');
  writeFileSync(planFile, JSON.stringify({ version: '1.0', steps: [{ type: 'wait', ms: 0 }] }));
  const config = join(home, 'account.json');
  const selector = source === 'config' ? ['--config', config] : [];
  function replace(token: string) {
    if (source === 'env') credentials = { SWITCHBOT_TOKEN: token, SWITCHBOT_SECRET: 'private-secret' };
    else {
      credentials = {};
      writeFileSync(config, JSON.stringify({ token, secret: 'private-secret' }));
    }
  }
  replace('first-private-token');
  const planId = cli('', ...selector, 'plan', 'save', planFile).body.data.planId;
  expect(cli('', ...selector, 'plan', 'approve', planId).status).toBe(0);
  replace('new-private-token');
  expect(cli('', ...selector, 'plan', 'execute', planId).body.error).toMatchObject({ kind: 'guard' });
  const persisted = readdirSync(dir).map(n => readFileSync(join(dir, n), 'utf8')).join('\\n');
  expect(persisted).not.toMatch(/private-(token|secret)/);
}, 30000);

it('checks the actual signing credentials after preflight before dispatching an outlet action', () => {
  const file = join(home, 'source.json');
  writeFileSync(file, JSON.stringify({ version: '1.0',
    steps: [{ type: 'command', deviceId: 'PLUG1', command: 'turnOn' }] }));
  const saved = cli('', 'plan', 'save', file);
  expect(saved.status, JSON.stringify(saved)).toBe(0);
  const planId = saved.body.data.planId;
  expect(cli('', 'plan', 'approve', planId).status).toBe(0);
  expect(cli('replace-before-signing', 'plan', 'execute', planId).status).not.toBe(0);
  expect(calls()).not.toContain('/v1.1/devices/PLUG1/commands');
}, 30000);

it('requires fresh approval to bind a selector-only legacy mutation before execution', () => {
  seed([{ type: 'scene', sceneId: 'A' }]);
  expect(cli('', 'plan', 'execute', id).body.error).toMatchObject({ kind: 'guard' });
  expect(cli('', 'plan', 'approve', id).status).toBe(0);
  expect(cli('', 'plan', 'execute', id).status).toBe(0);
  expect(calls()).toEqual(['/v1.1/scenes/A/execute']);
}, 30000);

it('rejects edited outlet actions on first execution and does not bless them on reapproval', () => {
  const file = join(home, 'source.json');
  writeFileSync(file, JSON.stringify({ version: '1.0', steps: [{ type: 'command', deviceId: 'PLUG1', command: 'turnOn' }] }));
  const planId = cli('', 'plan', 'save', file).body.data.planId;
  expect(cli('', 'plan', 'approve', planId).status).toBe(0);
  const stored = join(dir, `${planId}.json`);
  const record = JSON.parse(readFileSync(stored, 'utf8'));
  record.plan.steps[0].command = 'turnOff';
  writeFileSync(stored, JSON.stringify(record));

  const reapproval = cli('', 'plan', 'approve', planId);
  const execution = cli('', 'plan', 'execute', planId);
  expect(calls()).not.toContain('/v1.1/devices/PLUG1/commands');
  expect(reapproval.body.error).toMatchObject({ kind: 'guard' });
  expect(execution.body.error).toMatchObject({ kind: 'guard' });
}, 30000);

it('does not treat an edited status as proof of approval for a saved outlet action', () => {
  const file = join(home, 'source.json');
  writeFileSync(file, JSON.stringify({ version: '1.0', steps: [{ type: 'command', deviceId: 'PLUG1', command: 'turnOn' }] }));
  const planId = cli('', 'plan', 'save', file).body.data.planId;
  const stored = join(dir, `${planId}.json`);
  const record = JSON.parse(readFileSync(stored, 'utf8'));
  record.status = 'approved';
  writeFileSync(stored, JSON.stringify(record));
  expect(cli('', 'plan', 'execute', planId).body.error).toMatchObject({ kind: 'guard' });
  expect(calls()).not.toContain('/v1.1/devices/PLUG1/commands');
}, 30000);
