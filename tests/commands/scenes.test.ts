import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiMock = vi.hoisted(() => {
  const instance = { get: vi.fn(), post: vi.fn() };
  return {
    createClient: vi.fn(() => instance),
    __instance: instance,
  };
});

vi.mock('../../src/api/client.js', () => ({
  createClient: apiMock.createClient,
  ApiError: class ApiError extends Error {
    constructor(message: string, public readonly code: number) {
      super(message);
      this.name = 'ApiError';
    }
  },
  DryRunSignal: class DryRunSignal extends Error {
    constructor(public readonly method: string, public readonly url: string) {
      super('dry-run');
      this.name = 'DryRunSignal';
    }
  },
}));

import { registerScenesCommand } from '../../src/commands/scenes.js';
import { runCli } from '../helpers/cli.js';
import { expectJsonArrayEnvelope, expectJsonEnvelopeContainingKeys } from '../helpers/contracts.js';

describe('scenes command', () => {
  beforeEach(() => {
    apiMock.__instance.get.mockReset();
    apiMock.__instance.post.mockReset();
    apiMock.createClient.mockReset();
    apiMock.createClient.mockImplementation(() => apiMock.__instance);
  });

  describe('list', () => {
    it('renders a table of scenes in default mode', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: [
            { sceneId: 'S1', sceneName: 'Good Morning' },
            { sceneId: 'S2', sceneName: 'Movie Time' },
          ],
        },
      });
      const res = await runCli(registerScenesCommand, ['scenes', 'list']);
      expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/scenes');
      const out = res.stdout.join('\n');
      expect(out).toContain('S1');
      expect(out).toContain('Good Morning');
      expect(out).toContain('S2');
      expect(out).toContain('Movie Time');
    });

    it('in --json mode, outputs raw scenes as JSON and skips table', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: { body: [{ sceneId: 'S1', sceneName: 'Hi' }] },
      });
      const res = await runCli(registerScenesCommand, ['scenes', 'list', '--json']);
      const out = JSON.parse(res.stdout.join('\n')) as Record<string, unknown>;
      const data = expectJsonArrayEnvelope(out) as Array<{ sceneId: string; sceneName: string }>;
      expect(data[0].sceneId).toBe('S1');
      expect(data[0].sceneName).toBe('Hi');
    });

    it('prints "No scenes found" when the list is empty', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: [] } });
      const res = await runCli(registerScenesCommand, ['scenes', 'list']);
      expect(res.stdout.join('\n')).toContain('No scenes found');
    });

    it('exits 1 when the API throws', async () => {
      apiMock.__instance.get.mockRejectedValue(new Error('server down'));
      const res = await runCli(registerScenesCommand, ['scenes', 'list']);
      expect(res.exitCode).toBe(1);
      expect(res.stderr.join('\n')).toContain('server down');
    });

    it('--format=tsv outputs tab-separated scene data', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: [
            { sceneId: 'S1', sceneName: 'Good Morning' },
            { sceneId: 'S2', sceneName: 'Movie Time' },
          ],
        },
      });
      const res = await runCli(registerScenesCommand, ['scenes', 'list', '--format', 'tsv']);
      const lines = res.stdout.join('\n').split('\n');
      expect(lines[0]).toBe('sceneId\tsceneName');
      expect(lines[1]).toBe('S1\tGood Morning');
      expect(lines[2]).toBe('S2\tMovie Time');
    });

    it('--format=id outputs one sceneId per line', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: [
            { sceneId: 'S1', sceneName: 'Good Morning' },
            { sceneId: 'S2', sceneName: 'Movie Time' },
          ],
        },
      });
      const res = await runCli(registerScenesCommand, ['scenes', 'list', '--format', 'id']);
      const lines = res.stdout.join('\n').split('\n').filter(Boolean);
      expect(lines).toEqual(['S1', 'S2']);
    });
  });

  describe('execute', () => {
    it('POSTs to the scene execute endpoint and prints success', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: { body: [{ sceneId: 'SCENE-1', sceneName: 'Morning' }] },
      });
      apiMock.__instance.post.mockResolvedValue({ data: {} });
      const res = await runCli(registerScenesCommand, ['scenes', 'execute', 'SCENE-1']);
      expect(apiMock.__instance.post).toHaveBeenCalledWith('/v1.1/scenes/SCENE-1/execute');
      expect(res.stdout.join('\n')).toContain('Scene executed: SCENE-1');
    });

    it('exits 1 when execution fails', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: { body: [{ sceneId: 'missing', sceneName: 'X' }] },
      });
      apiMock.__instance.post.mockRejectedValue(new Error('not found'));
      const res = await runCli(registerScenesCommand, ['scenes', 'execute', 'missing']);
      expect(res.exitCode).toBe(1);
      expect(res.stderr.join('\n')).toContain('not found');
    });

    it('fails when sceneId is missing (commander error)', async () => {
      const res = await runCli(registerScenesCommand, ['scenes', 'execute']);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
      expect(res.stderr.join('\n').toLowerCase()).toContain('missing required');
    });

    it('exits 2 with scene_not_found and never calls executeScene for bogus sceneId (bug #31)', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: { body: [{ sceneId: 'S1', sceneName: 'Good Morning' }] },
      });
      const res = await runCli(registerScenesCommand, ['scenes', 'execute', 'BOGUS-ID', '--json']);
      expect(res.exitCode).toBe(2);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
      // Bug #SYS-1: --json errors now emit on stdout so piped consumers see them.
      const out = res.stdout.join('\n');
      const parsed = JSON.parse(out);
      expect(parsed.error?.context?.error).toBe('scene_not_found');
      expect(parsed.error?.context?.sceneId).toBe('BOGUS-ID');
    });

    it('--dry-run --json returns structured wouldSend on stdout (bug #54)', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: { body: [{ sceneId: 'SCENE-1', sceneName: 'Morning' }] },
      });
      const res = await runCli(registerScenesCommand, ['scenes', 'execute', 'SCENE-1', '--dry-run', '--json']);
      expect(res.exitCode).toBeNull();
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
      const out = res.stdout.join('\n');
      const parsed = JSON.parse(out);
      expect(parsed.data.dryRun).toBe(true);
      expect(parsed.data.wouldSend.sceneId).toBe('SCENE-1');
      expect(parsed.data.wouldSend.sceneName).toBe('Morning');
    });

    it('--dry-run plaintext prints Would POST on stdout (bug #54)', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: { body: [{ sceneId: 'SCENE-1', sceneName: 'Morning' }] },
      });
      const res = await runCli(registerScenesCommand, ['scenes', 'execute', 'SCENE-1', '--dry-run']);
      expect(res.exitCode).toBeNull();
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
      const out = res.stdout.join('\n');
      expect(out).toContain('[dry-run]');
      expect(out).toContain('SCENE-1');
    });

    it('--dry-run with bogus sceneId still exits 2 with scene_not_found (bug #54)', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: { body: [{ sceneId: 'S1', sceneName: 'Good Morning' }] },
      });
      const res = await runCli(registerScenesCommand, ['scenes', 'execute', 'BOGUS', '--dry-run', '--json']);
      expect(res.exitCode).toBe(2);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
      const out = res.stdout.join('\n');
      const parsed = JSON.parse(out);
      expect(parsed.error?.context?.error).toBe('scene_not_found');
    });
  });

  describe('describe', () => {
    it('returns scene metadata for a known sceneId', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: [
            { sceneId: 'S1', sceneName: 'Good Morning' },
            { sceneId: 'S2', sceneName: 'Movie Time' },
          ],
        },
      });
      const res = await runCli(registerScenesCommand, ['scenes', 'describe', 'S1', '--json']);
      expect(res.exitCode).toBeNull();
      const parsed = JSON.parse(res.stdout.join('\n')) as Record<string, unknown>;
      const data = expectJsonEnvelopeContainingKeys(parsed, ['sceneId', 'sceneName', 'stepCount', 'note']);
      expect(data.sceneId).toBe('S1');
      expect(data.sceneName).toBe('Good Morning');
      expect(data.stepCount).toBeNull();
      expect(String(data.note)).toMatch(/does not expose scene steps/);
    });

    it('exits 2 with scene_not_found when sceneId is unknown', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: [
            { sceneId: 'S1', sceneName: 'Good Morning' },
          ],
        },
      });
      const res = await runCli(registerScenesCommand, ['scenes', 'describe', 'MISSING', '--json']);
      expect(res.exitCode).toBe(2);
      // Bug #SYS-1: --json errors now emit on stdout so piped consumers see them.
      const out = res.stdout.join('\n');
      const parsed = JSON.parse(out);
      expect(parsed.error?.context?.error).toBe('scene_not_found');
      expect(parsed.error?.context?.sceneId).toBe('MISSING');
      expect(parsed.error?.context?.candidates).toHaveLength(1);
    });

    it('plaintext describe unknown sceneId renders "Did you mean" with candidates (R-3)', async () => {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: [
            { sceneId: 'S1', sceneName: 'Good Morning' },
            { sceneId: 'S2', sceneName: 'Movie Time' },
            { sceneId: 'S3', sceneName: 'Good Night' },
          ],
        },
      });
      const res = await runCli(registerScenesCommand, ['scenes', 'describe', 'MISSING']);
      expect(res.exitCode).toBe(2);
      const err = res.stderr.join('\n');
      expect(err).toContain('scene not found: MISSING');
      expect(err).toContain('Did you mean:');
      expect(err).toContain('Good Morning (S1)');
      expect(err).toContain('Movie Time (S2)');
    });

    it('plaintext describe unknown sceneId with empty list omits "Did you mean" (R-3)', async () => {
      apiMock.__instance.get.mockResolvedValue({ data: { body: [] } });
      const res = await runCli(registerScenesCommand, ['scenes', 'describe', 'MISSING']);
      expect(res.exitCode).toBe(2);
      const err = res.stderr.join('\n');
      expect(err).toContain('scene not found: MISSING');
      expect(err).not.toContain('Did you mean:');
    });
  });

  describe('explain', () => {
    function mockScenes() {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: [
            { sceneId: 'S1', sceneName: 'Good Morning' },
            { sceneId: 'S2', sceneName: 'Movie Time' },
          ],
        },
      });
    }

    it('--json returns explanation envelope with riskLevel and toExecute', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['--json', 'scenes', 'explain', 'S1']);
      expect(res.exitCode).not.toBe(2);
      const out = JSON.parse(res.stdout.find((l) => l.trim().startsWith('{'))!) as Record<string, unknown>;
      const data = expectJsonEnvelopeContainingKeys(out, ['sceneId', 'sceneName', 'riskLevel', 'toExecute', 'idempotent']);
      expect(data.sceneId).toBe('S1');
      expect(data.sceneName).toBe('Good Morning');
      expect(data.riskLevel).toBe('low');
      expect(data.toExecute).toBe('switchbot scenes execute S1');
      expect(data.idempotent).toBeNull();
    });

    it('plaintext output includes key explanation fields', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['scenes', 'explain', 'S1']);
      expect(res.exitCode).not.toBe(2);
      const out = res.stdout.join('\n');
      expect(out).toContain('Good Morning');
      expect(out).toContain('riskLevel');
      expect(out).toContain('toExecute');
      expect(out).toContain('scenes execute S1');
    });

    it('--json emits error envelope for unknown sceneId', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['--json', 'scenes', 'explain', 'MISSING']);
      expect(res.exitCode).toBe(2);
      const out = JSON.parse(res.stdout.find((l) => l.trim().startsWith('{'))!) as Record<string, unknown>;
      expect((out.error as Record<string, unknown>).message).toMatch(/scene not found/i);
    });
  });

  describe('validate', () => {
    function mockScenes() {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: [
            { sceneId: 'V1', sceneName: 'Sunrise' },
            { sceneId: 'V2', sceneName: 'Sunset' },
          ],
        },
      });
    }

    it('--json exits 0 with ok:true when all supplied IDs exist', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['--json', 'scenes', 'validate', 'V1', 'V2']);
      expect(res.exitCode).toBeNull();
      const body = JSON.parse(res.stdout.join('')) as Record<string, unknown>;
      const data = expectJsonEnvelopeContainingKeys(body, ['ok', 'results']) as { ok: boolean; results: unknown[] };
      expect(data.ok).toBe(true);
      expect(data.results).toHaveLength(2);
    });

    it('--json exits 1 with ok:false when a supplied ID does not exist', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['--json', 'scenes', 'validate', 'V1', 'MISSING']);
      expect(res.exitCode).toBe(1);
      const body = JSON.parse(res.stdout[0]) as { data: { ok: boolean; results: Array<{ sceneId: string; valid: boolean }> } };
      expect(body.data.ok).toBe(false);
      const missingEntry = body.data.results.find((r) => r.sceneId === 'MISSING');
      expect(missingEntry?.valid).toBe(false);
    });

    it('human mode exits 0 and prints ✓ for valid scenes', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['scenes', 'validate', 'V1']);
      expect(res.exitCode).toBeNull();
      expect(res.stdout.join(' ')).toContain('✓');
    });

    it('validates all scenes when no IDs are supplied', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['--json', 'scenes', 'validate']);
      expect(res.exitCode).toBeNull();
      const body = JSON.parse(res.stdout.join('')) as { data: { ok: boolean; results: unknown[] } };
      expect(body.data.results).toHaveLength(2);
    });
  });

  describe('simulate', () => {
    function mockScenes() {
      apiMock.__instance.get.mockResolvedValue({
        data: {
          body: [
            { sceneId: 'SIM1', sceneName: 'Good Night' },
          ],
        },
      });
    }

    it('--json returns simulated:true with wouldSend details', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['--json', 'scenes', 'simulate', 'SIM1']);
      expect(res.exitCode).toBeNull();
      const body = JSON.parse(res.stdout.join('')) as Record<string, unknown>;
      const data = expectJsonEnvelopeContainingKeys(body, ['simulated', 'sceneId', 'sceneName', 'wouldSend']) as Record<string, unknown>;
      expect(data.simulated).toBe(true);
      expect(data.sceneId).toBe('SIM1');
      expect(data.sceneName).toBe('Good Night');
      const wouldSend = data.wouldSend as Record<string, string>;
      expect(wouldSend.method).toBe('POST');
      expect(wouldSend.url).toContain('SIM1');
    });

    it('human mode prints sceneId, sceneName and wouldSend', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['scenes', 'simulate', 'SIM1']);
      expect(res.exitCode).toBeNull();
      const out = res.stdout.join('\n');
      expect(out).toContain('SIM1');
      expect(out).toContain('Good Night');
      expect(out).toContain('POST');
    });

    it('--json exits 2 with error envelope for unknown sceneId', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['--json', 'scenes', 'simulate', 'UNKNOWN']);
      expect(res.exitCode).toBe(2);
      const out = JSON.parse(res.stdout.find((l) => l.trim().startsWith('{'))!) as Record<string, unknown>;
      expect((out.error as Record<string, unknown>).message).toMatch(/scene not found/i);
    });
  });
});
