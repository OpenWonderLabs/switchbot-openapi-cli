import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const temporaryDirectories = [];
after(async () => {
  await Promise.all(temporaryDirectories.map((dir) => rm(dir, { recursive: true, force: true })));
});

function runDaemon(pathValue, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--input-type=module', '--eval',
      "import { checkDaemon } from './setup/check-daemon.js'; await checkDaemon();",
    ], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, PATH: pathValue, HOME: pathValue, USERPROFILE: pathValue, START_MARKER: marker },
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

describe('daemon bootstrap', () => {
  for (const enabled of [false, true]) {
    it(`keeps MCP stdout clean and starts the daemon only for enabled rules (${enabled})`, async () => {
      const binDir = await mkdtemp(join(tmpdir(), 'switchbot-openclaw-daemon-'));
      temporaryDirectories.push(binDir);
      const marker = join(binDir, 'daemon-started');
      const cliPath = process.platform === 'win32'
        ? join(binDir, 'node_modules', '@switchbot', 'openapi-cli', 'dist', 'index.js')
        : join(binDir, 'switchbot');
      await mkdir(dirname(cliPath), { recursive: true });
      await writeFile(cliPath, [
        '#!' + process.execPath,
        "const fs = require('node:fs'); const args = process.argv.slice(2);",
        "if (args[0] === 'daemon' && args[1] === 'status') console.log(JSON.stringify({data:{running:false}}));",
        "else if (args[0] === 'policy') console.log(JSON.stringify({data:{valid:true}}));",
        `else if (args[0] === 'rules') console.log(JSON.stringify({data:{automationEnabled:true,rules:[{enabled:${enabled}}]}}));`,
        "else if (args[0] === 'daemon' && args[1] === 'start') { fs.writeFileSync(process.env.START_MARKER, 'started'); console.log('daemon diagnostics'); }",
      ].join('\n'));
      await chmod(cliPath, 0o755);
      if (process.platform === 'win32') await writeFile(join(binDir, 'switchbot.cmd'), '@echo off\r\n');

      const result = await runDaemon(binDir, marker);

      assert.equal(result.code, 0);
      assert.equal(result.stdout, '');
      assert.equal(existsSync(marker), enabled);
      if (enabled) assert.match(result.stderr, /daemon diagnostics/);
    });
  }
});
