// Inject a proper require() implementation for CJS packages bundled into the
// ESM output. Without this, esbuild's __require2 shim throws
// "Dynamic require of X is not supported" when CJS packages call
// require('process'), require('events'), etc. (bare names, no node: prefix).
import { createRequire } from 'node:module';
export const require = createRequire(import.meta.url);
