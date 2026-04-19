import fs from 'node:fs';
import path from 'node:path';
import type { Sink, MqttSinkEvent } from './types.js';

export class FileSink implements Sink {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  async write(event: MqttSinkEvent): Promise<void> {
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(event) + '\n', { encoding: 'utf-8' });
    } catch {
      // best-effort
    }
  }
}
