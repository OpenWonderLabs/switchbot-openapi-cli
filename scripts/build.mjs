// scripts/build.mjs
// Single release-pipeline entry point. `npm run build` always calls this.
//
// Stages (one thing each; first failure aborts):
//   1. clean         wipe dist/ so nothing stale leaks into the tarball
//   2. typecheck     tsc --noEmit gate (types must still compile)
//   3. bundle        esbuild produces dist/index.js (shebang via banner.js)
//   4. copy-assets   copy policy schema/examples into dist/
//   5. ensure-binary assert shebang + chmod 0755 on dist/index.js
//
// The invariant this file enforces: whatever ships (prepublishOnly, publish.yml,
// smoke:pack-install) was produced by EXACTLY these five steps. No other script
// writes to dist/ on the release path.

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const isWindows = process.platform === 'win32';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';

const TOTAL = 5;
let stageIdx = 0;

function runStage(label, fn) {
  stageIdx += 1;
  console.log(`build: [${stageIdx}/${TOTAL}] ${label}`);
  try {
    fn();
  } catch (err) {
    console.error(`build: FAIL at ${label}`);
    console.error(err?.message ?? err);
    process.exit(1);
  }
}

function runNode(args) {
  const res = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`node ${args.join(' ')} exited with ${res.status}`);
  }
}

function runNpx(args) {
  const res = spawnSync(npxCmd, args, { cwd: repoRoot, stdio: 'inherit', shell: isWindows });
  if (res.status !== 0) {
    throw new Error(`npx ${args.join(' ')} exited with ${res.status}`);
  }
}

runStage('clean', () => {
  rmSync(join(repoRoot, 'dist'), { recursive: true, force: true });
});

runStage('typecheck', () => {
  runNpx(['tsc', '--noEmit']);
});

runStage('bundle', () => {
  runNode([join(scriptDir, 'bundle.mjs')]);
});

runStage('copy-assets', () => {
  runNode([join(scriptDir, 'copy-assets.mjs')]);
});

runStage('ensure-binary', () => {
  runNode([join(scriptDir, 'ensure-binary.mjs')]);
});

console.log('build: done');
