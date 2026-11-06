import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
const untouched = { 'default:token': 'unrelated-token', 'default:secret': 'unrelated-secret' };

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runSmoke(mode = 'healthy') {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'switchbot-keychain-smoke-'));
  directories.push(directory);
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  const registry = path.join(directory, 'registry.json');
  writeFileSync(registry, JSON.stringify(untouched));
  const which = path.join(bin, 'which');
  writeFileSync(which, `#!${process.execPath}\nif (process.env.KEYCHAIN_FIXTURE_MODE === 'fallback') process.exit(1);\nconsole.log(${JSON.stringify(path.join(bin, 'secret-tool'))});\n`);
  chmodSync(which, 0o755);
  const secretTool = path.join(bin, 'secret-tool');
  writeFileSync(secretTool, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = ${JSON.stringify(registry)};
const values = JSON.parse(fs.readFileSync(file, 'utf8'));
const account = args[args.indexOf('account') + 1];
switch (args[0]) {
  case 'search': break;
  case 'lookup':
    if (!(account in values)) process.exit(1);
    process.stdout.write(process.env.KEYCHAIN_FIXTURE_MODE === 'corrupt-read' ? 'corrupted-value' : values[account]);
    break;
  case 'store': values[account] = fs.readFileSync(0, 'utf8'); fs.writeFileSync(file, JSON.stringify(values)); break;
  case 'clear': delete values[account]; fs.writeFileSync(file, JSON.stringify(values)); break;
  default: process.exit(90);
}
`);
  chmodSync(secretTool, 0o755);
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/smoke-keychain.mjs'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: directory,
      GITHUB_ACTIONS: 'true', KEYCHAIN_FIXTURE_MODE: mode, PATH: bin + path.delimiter + process.env.PATH },
  });
  return { result, remaining: JSON.parse(readFileSync(registry, 'utf8')) };
}

// The production smoke runs native commands on all three runner OSes. This
// regression fixture implements only the external Linux secret-tool boundary.
describe.skipIf(process.platform !== 'linux')('native keychain smoke gate', () => {
  it('exercises replacement and cleanup without modifying other profiles', () => {
    const smoke = runSmoke();
    expect(smoke.result.status, smoke.result.stderr).toBe(0);
    expect(JSON.parse(smoke.result.stdout)).toEqual({ backend: 'secret-service', checks: ['create', 'replace', 'delete'] });
    expect(smoke.remaining).toEqual(untouched);
  });

  it.each(['fallback', 'corrupt-read'])('rejects %s without leaving dummy credentials behind', mode => {
    const smoke = runSmoke(mode);
    expect(smoke.result.status).toBe(1);
    expect(smoke.remaining).toEqual(untouched);
  });
});
