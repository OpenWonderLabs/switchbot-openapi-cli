import { execSync } from 'node:child_process';

export default function setup(): void {
  // Build once before the test run so tests that exercise the compiled CLI
  // (e.g. version.test.ts spawning `node dist/index.js --version`) see the
  // latest source. Runs once per vitest invocation, not per file.
  execSync('npm run build', { stdio: 'inherit' });
}
