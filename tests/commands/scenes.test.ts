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
  });
});
