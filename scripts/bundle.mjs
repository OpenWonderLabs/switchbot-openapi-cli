// scripts/bundle.mjs
// Production bundler: esbuild inlines pure-JS dependencies into a single
// dist/index.js, reducing install size. Heavy deps that use native bindings
// (mqtt, pino, axios, @modelcontextprotocol/sdk) remain in node_modules.

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: path.join(root, 'dist/index.js'),
  // Keep heavy native-binding or large deps external; they stay in node_modules.
  external: [
    'node:*',
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
