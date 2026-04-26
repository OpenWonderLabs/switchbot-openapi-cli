import { readEmbeddedAsset } from './utils/embedded-asset.js';

/**
 * Loaders for assets copied by `scripts/copy-assets.mjs` into `dist/policy/`.
 *
 * This module is deliberately placed at the top of `src/` so that, under tsx,
 * `import.meta.url` points at `<repo>/src/embedded-assets.ts` — the exact
 * source-tree counterpart of `<pkg>/dist/index.js` in the bundle. That means
 * `./policy/schema/v0.2.json` resolves to `src/policy/schema/v0.2.json` in
 * dev and `dist/policy/schema/v0.2.json` in prod without any fallback
 * probing.
 *
 * All policy-asset loaders (`src/policy/schema.ts`,
 * `src/commands/policy.ts::readEmbeddedTemplate`,
 * `src/commands/mcp.ts` policy_new handler) MUST route through these
 * functions — embedding new `import.meta.url` + `readFileSync` sites
 * elsewhere will re-introduce the bundle-vs-source path drift that required
 * the pre-3.3.0 fallback.
 */
export function readPolicySchemaJson(version: string): string {
  return readEmbeddedAsset(import.meta.url, `./policy/schema/v${version}.json`);
}

export function readPolicyExampleYaml(): string {
  return readEmbeddedAsset(import.meta.url, `./policy/examples/policy.example.yaml`);
}
