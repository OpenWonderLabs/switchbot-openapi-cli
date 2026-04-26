import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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

  const switchbotBin = process.platform === 'win32'
    ? path.join(workDir, 'node_modules', '.bin', 'switchbot.cmd')
    : path.join(workDir, 'node_modules', '.bin', 'switchbot');

  function runBin(args) {
    if (process.platform === 'win32') {
      return execFileSync(switchbotBin, args, {
        cwd: workDir,
        encoding: 'utf-8',
        shell: true,
      });
    }
    return execFileSync(switchbotBin, args, {
      cwd: workDir,
      encoding: 'utf-8',
    });
  }

  // 1. --version (existing check)
  const actualVersion = runBin(['--version']).trim();
  if (actualVersion !== expectedVersion) {
    throw new Error(`Packed CLI version mismatch: expected ${expectedVersion}, got ${actualVersion}`);
  }
  console.log(`pack-install smoke ok: switchbot --version -> ${actualVersion}`);

  // 2. policy new — exercises readEmbeddedAsset for the policy.example.yaml template.
  //    If the bundle's embedded-asset resolver can't find the template, this fails
  //    with ENOENT before writing the file — which is exactly the 3.2.2 P0.
  const policyPath = path.join(workDir, 'policy.yaml');
  runBin(['policy', 'new', policyPath]);
  const policyStat = statSync(policyPath);
  if (policyStat.size < 500) {
    throw new Error(`policy new wrote ${policyStat.size} bytes to ${policyPath}; expected >= 500`);
  }
  console.log(`pack-install smoke ok: policy new -> ${policyPath} (${policyStat.size} bytes)`);

  // 3. policy validate --json — exercises readEmbeddedAsset for schema/v0.2.json.
  //    This is the other loader site and would also be broken by a future drift
  //    in dist/ asset layout.
  const validateOut = runBin(['policy', 'validate', policyPath, '--json']);
  let parsed;
  try {
    parsed = JSON.parse(validateOut);
  } catch (e) {
    throw new Error(`policy validate --json did not return JSON: ${validateOut}`);
  }
  if (parsed?.data?.valid !== true) {
    throw new Error(`policy validate reported not valid: ${JSON.stringify(parsed)}`);
  }
  console.log(`pack-install smoke ok: policy validate -> { valid: true }`);
} finally {
  if (tarballPath) {
    rmSync(tarballPath, { force: true });
  }
  rmSync(workDir, { recursive: true, force: true });
}
