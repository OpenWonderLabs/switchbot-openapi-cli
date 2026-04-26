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
      const out = res.stdout.join('\n');
      expect(out).toContain('"sceneId"');
      expect(out).toContain('"sceneName"');
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
      const out = res.stdout.join('\n');
      const parsed = JSON.parse(out);
      expect(parsed.data.sceneId).toBe('S1');
      expect(parsed.data.sceneName).toBe('Good Morning');
      expect(parsed.data.stepCount).toBeNull();
      expect(parsed.data.note).toMatch(/does not expose scene steps/);
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
      expect((out.data as Record<string, unknown>).sceneId).toBe('S1');
      expect((out.data as Record<string, unknown>).sceneName).toBe('Good Morning');
      expect((out.data as Record<string, unknown>).riskLevel).toBe('low');
      expect((out.data as Record<string, unknown>).toExecute).toBe('switchbot scenes execute S1');
      expect((out.data as Record<string, unknown>).idempotent).toBeNull();
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
            { sceneId: 'S1', sceneName: 'Good Morning' },
            { sceneId: 'S2', sceneName: 'Movie Time' },
          ],
        },
      });
    }

    it('exits 0 when all specified sceneIds are valid', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['scenes', 'validate', 'S1']);
      expect(res.exitCode).toBeNull();
      expect(res.stdout.join(' ')).toMatch(/✓/);
    });

    it('exits 1 when a specified sceneId does not exist', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['scenes', 'validate', 'MISSING-SCENE']);
      expect(res.exitCode).toBe(1);
      expect(res.stdout.join(' ')).toMatch(/✗/);
    });

    it('--json emits ok:true when all IDs valid', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['--json', 'scenes', 'validate', 'S1']);
      expect(res.exitCode).toBeNull();
      const body = JSON.parse(res.stdout.join('')) as { data: { ok: boolean; results: Array<{ sceneId: string; valid: boolean }> } };
      expect(body.data.ok).toBe(true);
      expect(body.data.results[0].valid).toBe(true);
    });

    it('--json emits ok:false and exits 1 when an ID is not found', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['--json', 'scenes', 'validate', 'MISSING-SCENE']);
      expect(res.exitCode).toBe(1);
      const body = JSON.parse(res.stdout.find((l) => l.trim().startsWith('{'))!) as { data: { ok: boolean; results: Array<{ valid: boolean }> } };
      expect(body.data.ok).toBe(false);
      expect(body.data.results.some((r) => !r.valid)).toBe(true);
    });
  });

  describe('simulate', () => {
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

    it('--json emits simulation envelope with wouldSend and simulated:true', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['--json', 'scenes', 'simulate', 'S1']);
      expect(res.exitCode).toBeNull();
      const body = JSON.parse(res.stdout.join('')) as {
        data: { simulated: boolean; sceneId: string; wouldSend: { method: string; url: string } };
      };
      expect(body.data.simulated).toBe(true);
      expect(body.data.sceneId).toBe('S1');
      expect(body.data.wouldSend.method).toBe('POST');
      expect(body.data.wouldSend.url).toContain('S1');
    });

    it('human output prints sceneId, sceneName, and wouldSend', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['scenes', 'simulate', 'S1']);
      expect(res.exitCode).toBeNull();
      const out = res.stdout.join('\n');
      expect(out).toMatch(/sceneId/i);
      expect(out).toMatch(/wouldSend/i);
    });

    it('exits 2 with scene_not_found envelope for unknown sceneId', async () => {
      mockScenes();
      const res = await runCli(registerScenesCommand, ['--json', 'scenes', 'simulate', 'MISSING']);
      expect(res.exitCode).toBe(2);
      const body = JSON.parse(res.stdout.find((l) => l.trim().startsWith('{'))!) as {
        error: { message?: string; context?: { error?: string } };
      };
      const sig = body.error.context?.error ?? body.error.message ?? '';
      expect(sig).toMatch(/scene.?not.?found/i);
    });
  });
});
