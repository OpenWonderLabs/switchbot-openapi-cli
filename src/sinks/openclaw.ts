import type { Sink, MqttSinkEvent } from './types.js';

export interface OpenClawSinkOptions {
  url?: string;
  token: string;
  model: string;
}

export class OpenClawSink implements Sink {
  private url: string;
  private token: string;
  private model: string;

  constructor(opts: OpenClawSinkOptions) {
    this.url = (opts.url ?? 'http://localhost:18789').replace(/\/$/, '');
    this.token = opts.token;
    this.model = opts.model;
  }

  async write(event: MqttSinkEvent): Promise<void> {
    try {
      const res = await fetch(`${this.url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: event.text }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[openclaw] POST failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[openclaw] error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
