import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const readJson = (relative) => JSON.parse(readFileSync(path.join(packageRoot, relative), 'utf8'));
const { version } = readJson('package.json');
const marketplace = readJson('.claude-plugin/marketplace.json');
const plugin = readJson('plugins/switchbot/.claude-plugin/plugin.json');
const entry = marketplace.plugins?.find((item) => item.name === plugin.name);

const versions = [
  ['.claude-plugin/marketplace.json', entry?.version],
  ['plugins/switchbot/.claude-plugin/plugin.json', plugin.version],
];
// The repository release gate also supplies its GitHub marketplace manifest.
if (process.argv[2]) {
  const repositoryMarketplace = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  versions.push([process.argv[2], repositoryMarketplace.plugins?.find((item) => item.name === plugin.name)?.version]);
}
for (const [file, actual] of versions) {
  if (actual !== version) {
    throw new Error(`${file} version mismatch: expected ${version}, got ${actual ?? '<missing>'}. Update plugin metadata with package.json before packing or publishing.`);
  }
}
