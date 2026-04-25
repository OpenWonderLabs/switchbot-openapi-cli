import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const gitDir = path.join(repoRoot, '.git');
const gitConfig = path.join(gitDir, 'config');
const hookLine = '\thooksPath = .githooks';

if (!existsSync(gitDir) || !existsSync(gitConfig)) {
  process.exit(0);
}

try {
  const raw = readFileSync(gitConfig, 'utf-8');

  let next;
  if (/\[core\]/.test(raw)) {
    if (/^\s*hooksPath\s*=.*$/m.test(raw)) {
      next = raw.replace(/^\s*hooksPath\s*=.*$/m, hookLine);
    } else {
      next = raw.replace(/\[core\][^\[]*/m, (section) => `${section.trimEnd()}\n${hookLine}\n`);
    }
  } else {
    const prefix = raw.endsWith('\n') ? raw : `${raw}\n`;
    next = `${prefix}[core]\n${hookLine}\n`;
  }

  if (next !== raw) {
    writeFileSync(gitConfig, next, 'utf-8');
  }
} catch {
  // Best-effort only. Published-package consumers and non-git environments
  // should not fail install because of local hook setup.
}
