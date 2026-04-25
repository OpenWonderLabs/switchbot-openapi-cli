import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const NODE_SHEBANG = '#!/usr/bin/env node\n';

const assets = [
  ['src/policy/schema', 'dist/policy/schema'],
  ['src/policy/examples', 'dist/policy/examples'],
];

for (const [srcRel, dstRel] of assets) {
  const src = join(repoRoot, ...srcRel.split('/'));
  const dst = join(repoRoot, ...dstRel.split('/'));
  if (!existsSync(src)) {
    console.error(`copy-assets: source missing: ${src}`);
    process.exit(1);
  }
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log(`copy-assets: ${src} -> ${dst}`);
}

const cliEntry = join(repoRoot, 'dist', 'index.js');
if (!existsSync(cliEntry)) {
  console.error(`copy-assets: CLI entry missing: ${cliEntry}`);
  process.exit(1);
}

const cliSource = readFileSync(cliEntry, 'utf-8');
if (!cliSource.startsWith(NODE_SHEBANG)) {
  writeFileSync(cliEntry, NODE_SHEBANG + cliSource, 'utf-8');
}

try {
  chmodSync(cliEntry, 0o755);
} catch {
  // Best-effort on filesystems that ignore POSIX modes.
}
