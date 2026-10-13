import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, delimiter, dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);

function windowsCliEntry() {
  for (const pathEntry of (process.env.PATH ?? '').split(delimiter)) {
    if (!pathEntry) continue;
    const directory = pathEntry.replace(/^"(.*)"$/, '$1');
    const shim = resolve(directory, 'switchbot.cmd');
    if (!existsSync(shim)) continue;
    const modules = basename(directory).toLowerCase() === '.bin'
      ? resolve(directory, '..')
      : resolve(directory, 'node_modules');
    const entry = resolve(modules, '@switchbot', 'openapi-cli', 'dist', 'index.js');
    if (existsSync(entry)) return entry;
    const target = readFileSync(shim, 'utf8').match(/"([^"\r\n]+\.[cm]?js)"\s+%\*/)?.[1];
    if (target) {
      const explicitEntry = resolve(directory, target.replace(/%~?dp0%/gi, directory));
      if (existsSync(explicitEntry)) return explicitEntry;
    }
    const error = new Error(`The selected SwitchBot npm installation is incomplete: ${entry}`);
    error.code = 'ENOENT';
    throw error;
  }
  return resolve(dirname(require.resolve('@switchbot/openapi-cli/package.json')), 'dist/index.js');
}

/**
 * Returns argv for the CLI without invoking an npm .cmd shim on Windows.
 * Prefer the npm installation selected by PATH, including global prefixes and
 * local .bin directories; execute its real Node entry without shell parsing.
 */
export function switchbotInvocation(args) {
  if (process.platform !== 'win32') return { command: 'switchbot', args };
  return {
    command: process.execPath,
    args: [windowsCliEntry(), ...args],
  };
}
