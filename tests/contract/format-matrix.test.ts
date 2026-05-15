import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { HealthReport } from '../../src/utils/health.js';
import { runCli } from '../helpers/cli.js';

const healthMock = vi.hoisted(() => ({
  getHealthReport: vi.fn<[], HealthReport>(),
  toPrometheusText: vi.fn(() => ''),
}));
vi.mock('../../src/utils/health.js', () => healthMock);

import { registerHealthCommand } from '../../src/commands/health.js';
import { registerCatalogCommand } from '../../src/commands/catalog.js';
import { resetCatalogOverlayCache } from '../../src/devices/catalog.js';

const OK_REPORT: HealthReport = {
  generatedAt: '2026-05-15T00:00:00.000Z',
  overall: 'ok',
  process: { pid: 1, uptimeSeconds: 1, platform: 'linux', nodeVersion: 'v20.0.0', memoryMb: 50 },
  quota: { used: 0, limit: 10000, percentUsed: 0, remaining: 10000, status: 'ok' },
  audit: { present: false, recentErrors: 0, recentTotal: 0, errorRatePercent: 0, expectedErrors: 0, unexpectedErrors: 0, unexpectedRatePercent: 0, breakdown: {}, status: 'ok' },
  circuit: { name: 'switchbot-api', state: 'closed', failures: 0, status: 'ok' },
};

const FORMATS = ['json', 'jsonl', 'tsv', 'yaml', 'markdown'] as const;

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-fmt-matrix-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot);
  healthMock.getHealthReport.mockReset().mockReturnValue(OK_REPORT);
  resetCatalogOverlayCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetCatalogOverlayCache();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

function isValidJson(s: string): boolean {
  try { JSON.parse(s); return true; } catch { return false; }
}

function isValidJsonl(s: string): boolean {
  const lines = s.split('\n').filter(Boolean);
  return lines.length > 0 && lines.every((l) => isValidJson(l));
}

function isValidTsv(s: string): boolean {
  const lines = s.split('\n').filter(Boolean);
  if (lines.length < 2) return false;
  const cols = lines[0].split('\t').length;
  return lines.every((l) => l.split('\t').length === cols);
}

function isValidYaml(s: string): boolean {
  return s.includes('---') || s.includes(':');
}

function assertValidFormat(stdout: string, format: string): void {
  if (!stdout.trim()) return;
  switch (format) {
    case 'json': expect(isValidJson(stdout)).toBe(true); break;
    case 'jsonl': expect(isValidJsonl(stdout)).toBe(true); break;
    case 'tsv': expect(isValidTsv(stdout)).toBe(true); break;
    case 'yaml': expect(isValidYaml(stdout)).toBe(true); break;
    case 'markdown': expect(stdout).toMatch(/[|\-]/); break;
  }
}

describe('format matrix contract', () => {
  describe('health check', () => {
    for (const fmt of FORMATS) {
      it(`--format ${fmt} produces valid ${fmt} output`, async () => {
        const res = await runCli(registerHealthCommand, ['health', 'check', '--format', fmt]);
        expect(res.exitCode).toBeNull();
        const stdout = res.stdout.join('\n');
        assertValidFormat(stdout, fmt);
        expect(stdout).not.toMatch(/◦.*dry-run/);
      });
    }
  });

  describe('catalog list', () => {
    for (const fmt of FORMATS) {
      it(`--format ${fmt} produces valid ${fmt} output`, async () => {
        const res = await runCli(registerCatalogCommand, ['catalog', 'list', '--format', fmt]);
        expect(res.exitCode).toBeNull();
        const stdout = res.stdout.join('\n');
        assertValidFormat(stdout, fmt);
      });
    }
  });

  describe('stdout cleanliness', () => {
    for (const fmt of FORMATS) {
      it(`no dry-run text in stdout for --format ${fmt}`, async () => {
        const res = await runCli(registerCatalogCommand, ['catalog', 'list', '--format', fmt]);
        const stdout = res.stdout.join('\n');
        expect(stdout).not.toMatch(/dry-run|◦ dry/);
      });
    }
  });
});
