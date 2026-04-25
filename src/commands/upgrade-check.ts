import { Command } from 'commander';
import https from 'node:https';
import { isJsonMode, printJson } from '../utils/output.js';
import chalk from 'chalk';
import { VERSION as currentVersion } from '../version.js';

const pkgName = '@switchbot/openapi-cli';

function fetchLatestVersion(packageName: string, timeoutMs = 8000): Promise<string> {
  const encoded = packageName.replace('/', '%2F');
  // /latest is shorthand for dist-tags.latest — always the current stable
  // release tag, never a prerelease unless accidentally published as such.
  const url = `https://registry.npmjs.org/${encoded}/latest`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { version?: string };
          if (typeof body.version === 'string') resolve(body.version);
          else reject(new Error('version field missing from registry response'));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`registry request timed out after ${timeoutMs}ms`)); });
    req.on('error', reject);
  });
}

// Intentionally avoids the `semver` npm package (YAGNI): comparing two
// well-formed registry version strings needs only these 10 lines, and adding
// a runtime dep solely for version comparison would bloat install footprint.
function semverGt(a: string, b: string): boolean {
  const numParts = (v: string) => v.replace(/-.*$/, '').split('.').map((n) => Number.parseInt(n, 10));
  const [aMaj, aMin, aPat] = numParts(a);
  const [bMaj, bMin, bPat] = numParts(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  if (aPat !== bPat) return aPat > bPat;
  // Same numeric version: release (no prerelease) > prerelease
  return !a.includes('-') && b.includes('-');
}

export function registerUpgradeCheckCommand(program: Command): void {
  program
    .command('upgrade-check')
    .description('Check whether a newer version of this CLI is available on npm.')
    .option('--timeout <ms>', 'Registry request timeout in milliseconds (default: 8000)', (v) => Number.parseInt(v, 10))
    .action(async (opts: { timeout?: number }) => {
      let latestVersion: string;
      try {
        latestVersion = await fetchLatestVersion(pkgName, opts.timeout ?? 8000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isJsonMode()) {
          printJson({ ok: false, error: msg, current: currentVersion });
        } else {
          console.error(chalk.red(`upgrade-check failed: ${msg}`));
        }
        process.exit(1);
      }

      const upToDate = !semverGt(latestVersion, currentVersion);
      const currentMajor = Number.parseInt(currentVersion.split('.')[0], 10);
      const latestMajor = Number.parseInt(latestVersion.split('.')[0], 10);

      if (latestVersion.includes('-')) {
        const msg = `Latest registry version (${latestVersion}) is a prerelease — skipping update check.`;
        if (isJsonMode()) {
          printJson({
            current: currentVersion, latest: latestVersion, upToDate: true,
            updateAvailable: false, breakingChange: false, installCommand: null,
            note: msg,
          });
        } else {
          console.log(`${chalk.green('✓')} You are running the latest stable version (${currentVersion}). Registry latest (${latestVersion}) is a prerelease — skipping.`);
        }
        return;
      }

      const result = {
        current: currentVersion,
        latest: latestVersion,
        upToDate,
        updateAvailable: !upToDate,
        breakingChange: latestMajor > currentMajor,
        installCommand: upToDate ? null : `npm install -g ${pkgName}@${latestVersion}`,
      };

      if (isJsonMode()) {
        printJson(result);
        return;
      }

      if (upToDate) {
        console.log(`${chalk.green('✓')} You are running the latest version (${currentVersion}).`);
      } else {
        console.log(`${chalk.yellow('!')} Update available: ${chalk.bold(currentVersion)} → ${chalk.bold(latestVersion)}`);
        console.log(`  Run: ${chalk.cyan(`npm install -g ${pkgName}@${latestVersion}`)}`);
        process.exit(1);
      }
    });
}
