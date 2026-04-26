import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Read an asset shipped alongside the CLI. `relPath` is resolved against the
 * caller's `import.meta.url`.
 *
 * Callers MUST sit at the top of `src/` so that under tsx the source-tree
 * path (e.g. `./policy/schema/v0.2.json` → `src/policy/schema/v0.2.json`)
 * matches the bundle-tree path (`./policy/schema/v0.2.json` from
 * `dist/index.js` → `dist/policy/schema/v0.2.json`). `src/embedded-assets.ts`
 * is the canonical call-site for this reason — do NOT call this helper from
 * nested modules under `src/commands/` or `src/policy/`, because their
 * source-tree depth no longer matches the bundle entry and the path will
 * drift between dev and prod.
 */
export function readEmbeddedAsset(metaUrl: string, relPath: string): string {
  const resolved = fileURLToPath(new URL(relPath, metaUrl));
  return readFileSync(resolved, 'utf-8');
}
