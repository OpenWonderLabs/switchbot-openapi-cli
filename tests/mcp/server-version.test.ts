import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { VERSION } from '../../src/version.js';

describe('mcp server version', () => {
  it('VERSION constant matches package.json version', () => {
    // Read package.json from disk to get the expected version
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkgContent = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(pkgContent) as { version: string };
    const expectedVersion = pkg.version;

    // Verify the VERSION constant matches
    expect(VERSION).toBe(expectedVersion);
    expect(VERSION).toBe('2.5.0');
  });
});


