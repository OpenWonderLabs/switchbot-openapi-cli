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
    // native binding deps
    'mqtt',
    'pino',
    'pino-pretty',
    // large deps with native parts
    'axios',
    '@modelcontextprotocol/sdk',
    // pure-JS but large — inline separately if needed
  ],
  // Inject a createRequire-based require() so CJS packages bundled into the
  // ESM output can call require('process'), require('events'), etc. (bare names
  // without node: prefix) without hitting esbuild's __require2 "not supported" error.
  inject: [path.join(root, 'scripts/cjs-shim.mjs')],
  banner: {
    // The shebang must come first (Node.js requires it at byte 0).
    // The `const require` line runs BEFORE esbuild's __require IIFE (which checks
    // `typeof require !== "undefined"`), so CJS packages that call bare
    // require('process') or require('node:events') get the real Node require().
    js: [
      '#!/usr/bin/env node',
      'import { createRequire as __cjsReq } from "node:module";',
      'const require = __cjsReq(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
