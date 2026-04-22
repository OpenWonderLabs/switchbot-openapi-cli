import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const src = join(repoRoot, 'src', 'policy', 'schema');
const dst = join(repoRoot, 'dist', 'policy', 'schema');

if (!existsSync(src)) {
  console.error(`copy-assets: source missing: ${src}`);
  process.exit(1);
}

mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log(`copy-assets: ${src} -> ${dst}`);
