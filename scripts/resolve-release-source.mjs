#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function invalid(message) {
  const error = new Error(message);
  error.exitCode = 2;
  throw error;
}

async function main() {
  const index = process.argv.indexOf('--outcomes');
  if (index === -1 || !process.argv[index + 1]) invalid('--outcomes requires a manifest path');
  const outcomes = JSON.parse(readFileSync(process.argv[index + 1], 'utf8'));
  const source = outcomes?.source;
  if (typeof source?.tag !== 'string' || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(source.tag)
      || typeof source?.revision !== 'string' || !/^[0-9a-f]{40}$/.test(source.revision)) {
    invalid('Release source metadata is missing or invalid');
  }
  const cli = outcomes.packages?.find((item) => item.name === '@switchbot/openapi-cli');
  if (source.tag !== `v${cli?.version}`) invalid('Release tag does not match the CLI candidate version');
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) invalid('GITHUB_REPOSITORY is required');
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required for source verification');
  const api = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  async function get(path) {
    const response = await fetch(`${api}/repos/${repository}/${path}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GH_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub source lookup failed: HTTP ${response.status}`);
    return response.json();
  }
  const reference = await get(`git/ref/tags/${encodeURIComponent(source.tag)}`);
  if (reference.ref !== `refs/tags/${source.tag}`) throw new Error('GitHub returned a different release ref');
  let object = reference.object;
  if (object?.type === 'tag') {
    if (typeof object.sha !== 'string' || !/^[0-9a-f]{40}$/.test(object.sha)) throw new Error('Invalid annotated tag object');
    object = (await get(`git/tags/${object.sha}`)).object;
  }
  if (object?.type !== 'commit' || object.sha !== source.revision) {
    throw new Error('Release tag does not match the recorded candidate revision');
  }
  process.stdout.write(`revision=${source.revision}\ntag=${source.tag}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`release-source: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error?.exitCode === 2 ? 2 : 1;
}
