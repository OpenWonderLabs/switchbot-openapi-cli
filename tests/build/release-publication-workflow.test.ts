import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

const PublishWorkflow = z.object({
  jobs: z.object({ publish: z.object({ steps: z.array(z.object({
    name: z.string().optional(), run: z.string().optional(),
  })) }) }),
});

describe('candidate publication workflow', () => {
  it('publishes a root candidate without moving the installed latest version', () => {
    const workflow = PublishWorkflow.parse(parse(readFileSync('.github/workflows/publish.yml', 'utf8')));
    const step = workflow.jobs.publish.steps.find((item) => item.name === 'Publish root CLI to npm');
    if (!step?.run) throw new Error('root publication step is unavailable');
    const home = mkdtempSync(join(tmpdir(), 'switchbot-publish-registry-'));
    try {
      const registry = join(home, 'registry.json');
      const npm = join(home, 'npm');
      writeFileSync(registry, JSON.stringify({ latest: '3.8.1', next: '3.8.0' }));
      writeFileSync(npm, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nif (args[0] !== 'publish') process.exit(90);\nconst registry = ${JSON.stringify(registry)};\nconst tags = JSON.parse(fs.readFileSync(registry, 'utf8'));\nconst tagIndex = args.indexOf('--tag');\nconst tag = tagIndex < 0 ? 'latest' : args[tagIndex + 1];\ntags[tag] = '3.9.0';\nfs.writeFileSync(registry, JSON.stringify(tags));\n`);
      chmodSync(npm, 0o755);
      const published = spawnSync('/bin/bash', ['-c', step.run], {
        env: { ...process.env, PATH: home, NODE_AUTH_TOKEN: 'offline-fixture' },
        encoding: 'utf8',
      });
      expect(published.status).toBe(0);
      expect(JSON.parse(readFileSync(registry, 'utf8'))).toEqual({ latest: '3.8.1', next: '3.9.0' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
