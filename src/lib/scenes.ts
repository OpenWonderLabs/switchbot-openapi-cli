import type { AxiosInstance } from 'axios';
import { createClient } from '../api/client.js';

export interface Scene {
  sceneId: string;
  sceneName: string;
}

export async function fetchScenes(client?: AxiosInstance): Promise<Scene[]> {
  const c = client ?? createClient();
  const res = await c.get<{ body: Scene[] }>('/v1.1/scenes');
  return res.data.body;
}

export async function executeScene(sceneId: string, client?: AxiosInstance): Promise<void> {
  const c = client ?? createClient();
  await c.post(`/v1.1/scenes/${sceneId}/execute`);
}
