import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

describe('auth constants — env-var overrides present in source', () => {
  const src = readFileSync(
    path.join(fileURLToPath(import.meta.url), '../../../src/auth/constants.ts'),
    'utf-8',
  );

  it('OAUTH_CLIENT_SECRET reads from SWITCHBOT_OAUTH_CLIENT_SECRET env var', () => {
    expect(src).toMatch(/process\.env\.SWITCHBOT_OAUTH_CLIENT_SECRET/);
  });

  it('TOKEN_AES_KEY reads from SWITCHBOT_TOKEN_AES_KEY env var', () => {
    expect(src).toMatch(/process\.env\.SWITCHBOT_TOKEN_AES_KEY/);
  });

  it('TOKEN_AES_IV reads from SWITCHBOT_TOKEN_AES_IV env var', () => {
    expect(src).toMatch(/process\.env\.SWITCHBOT_TOKEN_AES_IV/);
  });
});
