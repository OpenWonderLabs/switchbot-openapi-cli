import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const releaseRevision = 'b'.repeat(40);
const dispatcherRevision = 'a'.repeat(40);
const tagObject = 'c'.repeat(40);

async function resolveSource(
  source: { tag: string; revision: string } | undefined,
  taggedRevision: string,
  cliVersion = '3.9.0',
  options: { lightweight?: boolean; returnedRef?: string } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'switchbot-release-source-'));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/repos/OpenWonderLabs/switchbot-openapi-cli/git/ref/tags/v3.9.0') {
      response.end(JSON.stringify({
        ref: options.returnedRef ?? 'refs/tags/v3.9.0',
        object: options.lightweight ? { type: 'commit', sha: taggedRevision } : { type: 'tag', sha: tagObject },
      }));
    } else if (request.url === `/repos/OpenWonderLabs/switchbot-openapi-cli/git/tags/${tagObject}`) {
      response.end(JSON.stringify({ object: { type: 'commit', sha: taggedRevision } }));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('metadata fixture did not bind');
  try {
    const outcomes = join(directory, 'outcomes.json');
    writeFileSync(outcomes, JSON.stringify({
      schemaVersion: 1,
      source,
      packages: [{ name: '@switchbot/openapi-cli', version: cliVersion, outcome: 'published' }],
    }));
    const child = spawn(process.execPath, ['scripts/resolve-release-source.mjs', '--outcomes', outcomes], {
      cwd: process.cwd(),
      env: { ...process.env,
        GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        GITHUB_REPOSITORY: 'OpenWonderLabs/switchbot-openapi-cli',
        GITHUB_SHA: dispatcherRevision,
        GH_TOKEN: 'read-only-fixture',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { status, stdout, stderr, requests };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('release source binding', () => {
  it('checks out the annotated release tag source rather than the workflow dispatcher revision', async () => {
    const result = await resolveSource({ tag: 'v3.9.0', revision: releaseRevision }, releaseRevision);
    expect(result.status, result.stderr).toBe(0);
    expect(Object.fromEntries(result.stdout.trim().split('\n').map((line) => line.split('='))))
      .toEqual({ revision: releaseRevision, tag: 'v3.9.0' });
    expect(result.requests).toEqual([
      '/repos/OpenWonderLabs/switchbot-openapi-cli/git/ref/tags/v3.9.0',
      `/repos/OpenWonderLabs/switchbot-openapi-cli/git/tags/${tagObject}`,
    ]);
  });
  it('accepts a lightweight release tag bound to the candidate source', async () => {
    const result = await resolveSource({ tag: 'v3.9.0', revision: releaseRevision }, releaseRevision, '3.9.0', { lightweight: true });
    expect(result.status, result.stderr).toBe(0);
    expect(Object.fromEntries(result.stdout.trim().split('\n').map((line) => line.split('='))))
      .toEqual({ revision: releaseRevision, tag: 'v3.9.0' });
  });

  it('rejects a different ref even when it identifies the same commit', async () => {
    const result = await resolveSource({ tag: 'v3.9.0', revision: releaseRevision }, releaseRevision, '3.9.0', { returnedRef: 'refs/tags/v3.8.1' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });


  it('rejects a tag that no longer identifies the recorded candidate source', async () => {
    const result = await resolveSource({ tag: 'v3.9.0', revision: releaseRevision }, 'd'.repeat(40));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.requests).toContain(`/repos/OpenWonderLabs/switchbot-openapi-cli/git/tags/${tagObject}`);
  });

  it('rejects a release tag/version mismatch before querying GitHub', async () => {
    const result = await resolveSource({ tag: 'v3.9.0', revision: releaseRevision }, releaseRevision, '3.8.1');
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.requests).toEqual([]);
  });

  it('rejects missing source metadata instead of falling back to the workflow dispatcher', async () => {
    const result = await resolveSource(undefined, releaseRevision);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.requests).toEqual([]);
  });
});
