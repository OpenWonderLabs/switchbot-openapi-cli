import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);

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
