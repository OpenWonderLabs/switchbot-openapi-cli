import type { Sink, MqttSinkEvent } from './types.js';

export class WebhookSink implements Sink {
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async write(event: MqttSinkEvent): Promise<void> {
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.error(`[webhook] POST failed: HTTP ${res.status}`);
      }
    } catch (err) {
      console.error(`[webhook] error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
