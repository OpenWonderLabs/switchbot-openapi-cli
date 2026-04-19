import type { Sink, MqttSinkEvent } from './types.js';

export interface TelegramSinkOptions {
  token: string;
  chatId: string;
}

export class TelegramSink implements Sink {
  private token: string;
  private chatId: string;

  constructor(opts: TelegramSinkOptions) {
    this.token = opts.token;
    this.chatId = opts.chatId;
  }

  async write(event: MqttSinkEvent): Promise<void> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: event.text,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[telegram] POST failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[telegram] error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
