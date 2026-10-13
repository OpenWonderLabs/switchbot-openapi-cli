import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerMindclipCommand } from '../../src/commands/mindclip.js';

const apiMock = vi.hoisted(() => {
  const instance = { get: vi.fn() };
  return { createClient: vi.fn(() => instance), __instance: instance };
});

const outputMock = vi.hoisted(() => ({
  printJson: vi.fn(),
  handleError: vi.fn((error: unknown) => { throw error; }),
}));

vi.mock('../../src/api/client.js', () => ({
  createClient: apiMock.createClient,
}));

vi.mock('../../src/utils/output.js', () => outputMock);

function buildProgram(): Command {
  const program = new Command().exitOverride();
  registerMindclipCommand(program);
  return program;
}

beforeEach(() => {
  apiMock.__instance.get.mockReset();
  outputMock.printJson.mockClear();
});

describe('mindclip transcript CLI', () => {
  it('requests the encoded transcript resource and prints the raw transcript payload', async () => {
    const transcript = {
      transcribeStatus: 2,
      transcribeResult: '{\"segments\":[{\"text\":\"Meetings Tomorrow\"}]}',
      speakers: [{ speaker: 'speaker_1', speakerName: 'John' }],
    };
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: transcript } });

    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'transcript', 'recording/1?#']);

    expect(apiMock.__instance.get).toHaveBeenCalledWith(
      '/v1.1/mindclip/recordings/recording%2F1%3F%23/transcript',
      { params: {} },
    );
    expect(outputMock.printJson).toHaveBeenCalledWith(transcript);
  });
});
