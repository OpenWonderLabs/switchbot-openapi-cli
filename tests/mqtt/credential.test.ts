import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import axios from 'axios';
import { fetchCredential, loadCachedCredential, saveCachedCredential, getCredential } from '../../src/mqtt/credential.js';

vi.mock('axios');
vi.mock('node:fs/promises');

const mockAxios = axios as unknown as { post: ReturnType<typeof vi.fn> };
const mockFs = fs as unknown as {
  readFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
};

const TOKEN = 'test-token';
const SECRET = 'test-secret';

const mockCredentialResponse = {
  data: {
    statusCode: 100,
    body: {
      brokerUrl: 'mqtts://broker.example.com:8883',
      clientId: 'test-client-id',
      topics: ['switchbot/things/ABC123/shadow/update/documents'],
      tls: {
        caBase64: 'Q0FfQkFTRTY0',
        certBase64: 'Q0VSVFwiQkFTRTY0',
        keyBase64: 'S0VZX0JBU0U2NA==',
      },
      qos: 1,
    },
  },
};

describe('credential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('fetchCredential', () => {
    it('fetches credential from endpoint with correct auth headers', async () => {
      mockAxios.post.mockResolvedValue(mockCredentialResponse);
      const result = await fetchCredential(TOKEN, SECRET);

      expect(mockAxios.post).toHaveBeenCalledWith(
        'https://api.switchbot.net/v1.1/iot/credential',
        {},
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: TOKEN,
            src: 'OpenClaw',
          }),
        }),
      );

      expect(result).toMatchObject({
        brokerUrl: 'mqtts://broker.example.com:8883',
        clientId: 'test-client-id',
        tls: expect.any(Object),
      });
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    });

    it('throws on non-100 status code', async () => {
      mockAxios.post.mockResolvedValue({
        data: {
          statusCode: 401,
          body: { message: 'Unauthorized' },
        },
      });

      await expect(fetchCredential(TOKEN, SECRET)).rejects.toThrow(/Unauthorized/);
    });
  });

  describe('loadCachedCredential', () => {
    it('returns null if cache file does not exist', async () => {
      mockFs.readFile.mockRejectedValue(new Error('ENOENT'));
      const result = await loadCachedCredential();
      expect(result).toBeNull();
    });

    it('returns cached credential if not expired', async () => {
      const cachedCred = {
        ...mockCredentialResponse.data.body,
        expiresAt: Date.now() + 3600000,
      };
      mockFs.readFile.mockResolvedValue(JSON.stringify(cachedCred));

      const result = await loadCachedCredential();
      expect(result).toEqual(cachedCred);
    });

    it('returns null if cached credential is expired', async () => {
      const expiredCred = {
        ...mockCredentialResponse.data.body,
        expiresAt: Date.now() - 1000,
      };
      mockFs.readFile.mockResolvedValue(JSON.stringify(expiredCred));

      const result = await loadCachedCredential();
      expect(result).toBeNull();
    });
  });

  describe('saveCachedCredential', () => {
    it('writes credential to cache file with atomic rename', async () => {
      const cred = {
        brokerUrl: 'test',
        clientId: 'test',
        topics: [],
        tls: { caBase64: '', certBase64: '', keyBase64: '' },
        qos: 1,
        expiresAt: Date.now() + 3600000,
      };

      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      await saveCachedCredential(cred);

      expect(mockFs.mkdir).toHaveBeenCalled();
      expect(mockFs.writeFile).toHaveBeenCalledWith(expect.stringContaining('.tmp'), expect.any(String));
      expect(mockFs.rename).toHaveBeenCalled();
    });
  });

  describe('getCredential', () => {
    it('returns cached credential if available', async () => {
      const cachedCred = {
        ...mockCredentialResponse.data.body,
        expiresAt: Date.now() + 3600000,
      };
      mockFs.readFile.mockResolvedValue(JSON.stringify(cachedCred));

      const result = await getCredential(TOKEN, SECRET);
      expect(result).toEqual(cachedCred);
      expect(mockAxios.post).not.toHaveBeenCalled();
    });

    it('fetches fresh credential if cache expired', async () => {
      mockFs.readFile.mockRejectedValue(new Error('ENOENT'));
      mockAxios.post.mockResolvedValue(mockCredentialResponse);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      const result = await getCredential(TOKEN, SECRET);
      expect(result).toMatchObject({
        brokerUrl: 'mqtts://broker.example.com:8883',
      });
      expect(mockAxios.post).toHaveBeenCalled();
      expect(mockFs.writeFile).toHaveBeenCalled();
    });

    it('skips cache if noCache=true', async () => {
      mockAxios.post.mockResolvedValue(mockCredentialResponse);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      const result = await getCredential(TOKEN, SECRET, true);
      expect(result).toMatchObject({
        brokerUrl: 'mqtts://broker.example.com:8883',
      });
      expect(mockAxios.post).toHaveBeenCalled();
    });
  });
});
