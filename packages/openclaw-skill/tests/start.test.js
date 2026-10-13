import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const emptyPaths = [];

after(async () => {
  await Promise.all(emptyPaths.map((dir) => rm(dir, { recursive: true, force: true })));
});

function runBootstrap(pathValue, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/start.js'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, ...env, PATH: pathValue },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('MCP bootstrap', () => {
  it('keeps stdout empty when setup prerequisites are unavailable', async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), 'switchbot-openclaw-empty-path-'));
    emptyPaths.push(emptyPath);

    const result = await runBootstrap(emptyPath);

    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Setup required/);
  });

  it('does not install global packages or pollute MCP stdout when only npm is available', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'switchbot-openclaw-npm-only-'));
    emptyPaths.push(binDir);
    const installMarker = join(binDir, 'global-install-attempt');
    const npmPath = join(binDir, 'npm');
    await writeFile(npmPath, [
      '#!' + process.execPath,
      "const fs = require('node:fs');",
      "if (process.argv[2] === '--version') process.stdout.write('11.0.0\\n');",
      "else { fs.writeFileSync(process.env.INSTALL_MARKER, 'attempted'); process.stdout.write('npm install progress\\n'); process.exitCode = 1; }",
    ].join('\n'));
    await chmod(npmPath, 0o755);

    const result = await runBootstrap(binDir, { INSTALL_MARKER: installMarker });

    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Setup required/);
    await assert.rejects(readFile(installMarker), { code: 'ENOENT' });
  });

  it('rejects a CLI below 3.9.0 before invoking any MCP bootstrap checks', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'switchbot-openclaw-old-cli-'));
    emptyPaths.push(binDir);
    const tracePath = join(binDir, 'trace');
    const cliPath = join(binDir, 'switchbot');
    await writeFile(cliPath, [
      '#!' + process.execPath,
      "const fs = require('node:fs'); fs.appendFileSync(process.env.TRACE_FILE, process.argv.slice(2).join(' ') + '\\n'); process.stdout.write('3.8.9\\n');",
    ].join('\n'));
    await chmod(cliPath, 0o755);

    const result = await runBootstrap(binDir, { TRACE_FILE: tracePath });

    assert.notEqual(result.code, 0);
    assert.deepEqual((await readFile(tracePath, 'utf8')).trim().split('\n'), ['--version']);
  });
});
