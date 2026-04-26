import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Resolve an asset shipped alongside the CLI. Tries each candidate relative
 * to the caller's `import.meta.url`, which points at the source file under
 * tsx/dev but at the bundle (`dist/index.js`) after esbuild. Returns the
 * first file that exists; throws an ENOENT Error listing both attempted
 * paths otherwise — a future drift in asset layout is debuggable at a glance.
 */
export function readEmbeddedAsset(metaUrl: string, candidates: readonly string[]): string {
  const tried: string[] = [];
  for (const rel of candidates) {
    const p = fileURLToPath(new URL(rel, metaUrl));
    tried.push(p);
    if (existsSync(p)) return readFileSync(p, 'utf-8');
  }
  const err = new Error(`embedded asset not found. Tried:\n  ${tried.join('\n  ')}`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
}
