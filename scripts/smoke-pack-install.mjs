import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
const expectedVersion = String(pkg.version);

function runNpm(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return execFileSync(process.execPath, [npmExecPath, ...args], options);
  }
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return execFileSync(npmCmd, args, options);
}

const workDir = mkdtempSync(path.join(os.tmpdir(), 'switchbot-pack-smoke-'));
let tarballPath = null;

try {
  const packJson = runNpm(['pack', '--json'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  const [packResult] = JSON.parse(packJson);
  if (!packResult?.filename) {
    throw new Error(`npm pack did not return a filename: ${packJson}`);
  }

  tarballPath = path.join(repoRoot, packResult.filename);

  runNpm(['init', '-y'], {
    cwd: workDir,
    stdio: 'ignore',
  });

  runNpm(['install', tarballPath], {
    cwd: workDir,
    stdio: 'inherit',
  });

  const actualVersion = process.platform === 'win32'
    ? execFileSync(path.join(workDir, 'node_modules', '.bin', 'switchbot.cmd'), ['--version'], {
        cwd: workDir,
        encoding: 'utf-8',
        shell: true,
      }).trim()
    : execFileSync(path.join(workDir, 'node_modules', '.bin', 'switchbot'), ['--version'], {
        cwd: workDir,
        encoding: 'utf-8',
      }).trim();

  if (actualVersion !== expectedVersion) {
    throw new Error(`Packed CLI version mismatch: expected ${expectedVersion}, got ${actualVersion}`);
  }

  console.log(`pack-install smoke ok: switchbot --version -> ${actualVersion}`);
} finally {
  if (tarballPath) {
    rmSync(tarballPath, { force: true });
  }
  rmSync(workDir, { recursive: true, force: true });
}
