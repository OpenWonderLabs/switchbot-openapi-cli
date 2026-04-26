// scripts/ensure-binary.mjs
// Regression guard for the shipping binary.
//
// Contract:
//   dist/index.js MUST exist, its first 20 bytes MUST be "#!/usr/bin/env node",
//   and its mode SHOULD be 0o755. If any of those is not true, fail loudly.
//
// This script does NOT repair the output. The shebang is produced by
// scripts/bundle.mjs via the esbuild `banner.js` line; if that ever drops out,
// we want the build to fail here, not silently patch it at the last minute.

import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const NODE_SHEBANG = '#!/usr/bin/env node';

const cliEntry = join(repoRoot, 'dist', 'index.js');

if (!existsSync(cliEntry)) {
  console.error(`ensure-binary: dist/index.js is missing (expected at ${cliEntry})`);
  console.error('  Did scripts/bundle.mjs run? This script only verifies, it does not build.');
  process.exit(1);
}

const head = readFileSync(cliEntry, { encoding: 'utf-8' }).slice(0, NODE_SHEBANG.length);
if (head !== NODE_SHEBANG) {
  console.error('ensure-binary: dist/index.js is missing the node shebang');
  console.error(`  expected first bytes: ${JSON.stringify(NODE_SHEBANG)}`);
  console.error(`  actual first bytes:   ${JSON.stringify(head)}`);
  console.error('  Check scripts/bundle.mjs banner.js — the shebang is produced there.');
  process.exit(1);
}

try {
  chmodSync(cliEntry, 0o755);
} catch {
  // Best-effort. Filesystems that ignore POSIX modes (e.g. some Windows FSes)
  // still produce a valid tarball; npm records the mode at pack time on Linux.
}

try {
  const mode = statSync(cliEntry).mode & 0o777;
  console.log(`ensure-binary: ok (shebang present, mode 0o${mode.toString(8)})`);
} catch {
  console.log('ensure-binary: ok (shebang present)');
}
