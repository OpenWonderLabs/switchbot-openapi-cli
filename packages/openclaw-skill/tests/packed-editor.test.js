import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

it('can edit policy after archive extraction without installing dependencies', async () => {
  const work = await mkdtemp(join(tmpdir(), 'switchbot-packed-editor-'));
  let server;
  try {
    const npmEntry = process.env.npm_execpath;
    const args = ['pack', '--json', '--pack-destination', work];
    const output = execFileSync(npmEntry ? process.execPath : 'npm', npmEntry ? [npmEntry, ...args] : args, {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      timeout: 60_000,
      shell: !npmEntry && process.platform === 'win32',
    });
    const [{ filename }] = JSON.parse(output);
    execFileSync('tar', ['-xzf', join(work, filename), '-C', work], { timeout: 10_000 });
    const module = await import(pathToFileURL(join(work, 'package', 'policy-editor', 'server.js')).href);
    server = await module.startEditorServer({ port: 0, dryRun: true, policyPath: join(work, 'policy.yaml') });
    const url = `http://127.0.0.1:${server.port}`;
    const editResponse = await fetch(`${url}/policy/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'version: "0.2"\n# preserve operator comment\naliases:\n  lamp: ABCDEF123456\nconfirmations:\n  always_confirm: [setAll]\n',
        edit: { kind: 'confirm-lock', enabled: true },
      }),
    });
    assert.equal(editResponse.status, 200);
    const editedSource = await editResponse.text();
    assert.match(editedSource, /# preserve operator comment/);
    assert.match(editedSource, /setAll/);
    const stateResponse = await fetch(`${url}/policy/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: editedSource }),
    });
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.confirmLock, true);
    assert.deepEqual(state.aliases, { lamp: 'ABCDEF123456' });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(work, { recursive: true, force: true });
  }
});
