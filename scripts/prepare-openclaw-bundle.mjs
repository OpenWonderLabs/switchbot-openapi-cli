import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dependency = dirname(createRequire(import.meta.url).resolve('yaml/package.json'));
const destination = join(repoRoot, 'packages', 'openclaw-skill', 'node_modules', 'yaml');

rmSync(destination, { recursive: true, force: true });
mkdirSync(dirname(destination), { recursive: true });
cpSync(dependency, destination, { recursive: true });
