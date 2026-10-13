import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeInstall } from '../bin/install.js';

function makeOkCliCheck(version = '3.9.0') {
  return async () => ({ ok: true, version });
}
function makeFailCliCheck() {
  return async () => ({ ok: false, message: 'CLI not found' });
}
function makeSpawn(exitCode = 0) {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push({ cmd, args });
    return Promise.resolve(exitCode);
  };
  return { spawn, calls };
}

const TEST_ROOT = '/fake/codex-plugin';

describe('makeInstall', () => {
  it('returns the CLI install failure without attempting setup', async () => {
    const { spawn, calls } = makeSpawn(1);
    const install = makeInstall({
      checkCli: makeFailCliCheck(),
      runInherit: spawn,
    });

    const code = await install();

    assert.equal(code, 1);
    assert.deepEqual(calls, [{ cmd: 'npm', args: ['install', '-g', '@switchbot/openapi-cli@latest'] }]);
  });

  it('does not register after a successful install leaves an incompatible CLI', async () => {
    const { spawn, calls } = makeSpawn(0);
    const install = makeInstall({ checkCli: makeFailCliCheck(), runInherit: spawn });
    assert.equal(await install(), 1);
    assert.equal(calls.some((call) => call.cmd === 'switchbot'), false);
  });


  it('preserves a same-name third-party marketplace by delegating registration', async () => {
    const marketplaces = new Map([['codex-plugin', '/third-party/codex-plugin-marketplace']]);
    const runInherit = async (cmd, args) => {
      if (cmd === 'codex' && args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
        marketplaces.delete(args[3]);
      }
      if (cmd === 'codex' && args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
        marketplaces.set('switchbot', TEST_ROOT);
      }
      return 0;
    };
    const install = makeInstall({
      checkCli: makeOkCliCheck(),
      runInherit,
    });

    const code = await install();

    assert.equal(code, 0);
    assert.deepEqual(
      marketplaces,
      new Map([['codex-plugin', '/third-party/codex-plugin-marketplace']]),
    );
  });
});

