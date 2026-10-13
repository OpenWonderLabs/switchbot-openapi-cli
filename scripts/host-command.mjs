#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';

const [timeoutText, command, encodedArgs] = process.argv.slice(2);
const timeout = Number(timeoutText);
let args;
try {
  args = JSON.parse(encodedArgs);
} catch {
  process.stdout.write(JSON.stringify({ status: null, stdout: '', stderr: '', error: 'Invalid command arguments.', timedOut: false }));
  process.exitCode = 1;
  process.exit();
}

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
let timedOut = false;
let completed = false;

function finish(result) {
  if (completed) return;
  completed = true;
  clearTimeout(timer);
  process.stdout.write(`${JSON.stringify({ stdout, stderr, timedOut, ...result })}\n`);
}

function stopProcessTree() {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', shell: false });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

const timer = setTimeout(() => {
  timedOut = true;
  stopProcessTree();
}, Number.isFinite(timeout) && timeout > 0 ? timeout : 30000);

child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });
child.on('error', (error) => finish({ status: null, error: error.message }));
child.on('close', (status, signal) => finish({
  status,
  signal,
  error: timedOut ? `Timed out after ${timeout}ms.` : null,
}));
