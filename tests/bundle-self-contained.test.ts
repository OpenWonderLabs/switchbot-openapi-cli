import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(here, '..', 'package.json'), 'utf-8'),
) as { dependencies: Record<string, string> };

const bundle = readFileSync(path.join(here, '..', 'dist', 'index.js'), 'utf-8');

describe('bundle self-containment: @modelcontextprotocol/sdk', () => {
  it('is not listed as a runtime dependency (bundled, not external)', () => {
    expect(pkg.dependencies).not.toHaveProperty('@modelcontextprotocol/sdk');
  });

  it('dist/index.js does not import it externally', () => {
    // esbuild ESM external leaves a bare top-level import statement.
    // Exclude comment lines (JSDoc examples contain the package name as text).
    const lines = bundle.split('\n');
    const externalImports = lines.filter(
      (l) => /^\s*import\s/.test(l) && l.includes('@modelcontextprotocol/sdk'),
    );
    expect(externalImports).toHaveLength(0);
  });
});
