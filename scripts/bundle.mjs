// scripts/bundle.mjs
// Production bundler: esbuild inlines pure-JS dependencies into a single
// dist/index.js, reducing install size. Heavy deps that use native bindings
// (mqtt, pino, axios, @modelcontextprotocol/sdk) remain in node_modules.

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const outfile = process.env.BUNDLE_OUTFILE ?? path.join(root, 'dist/index.js');

await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile,
  // Keep heavy native-binding or large deps external; they stay in node_modules.
  external: [
    'node:*',
    // commander uses CJS require('node:events') internally; its CJS-to-ESM
    // interop in esbuild's shim breaks under Node 22. Keep it external.
    'commander',
    // native binding deps
    'mqtt',
    'pino',
    'pino-pretty',
    // large deps with native parts
    'axios',
    '@modelcontextprotocol/sdk',
    // pure-JS but large — inline separately if needed
  ],
  banner: {
    js: '#!/usr/bin/env node',
  },
  logLevel: 'info',
});
