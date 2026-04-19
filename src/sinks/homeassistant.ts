import type { Sink, MqttSinkEvent } from './types.js';

export interface HomeAssistantSinkOptions {
  url: string;
  /** Long-lived access token — used when webhookId is not set */
  token?: string;
  /** Webhook ID — no auth required, takes priority over token */
  webhookId?: string;
  /** Event type for REST event API (default: switchbot_event) */
  eventType?: string;
}

export class HomeAssistantSink implements Sink {
  private url: string;
  private token?: string;
  private webhookId?: string;
  private eventType: string;

  constructor(opts: HomeAssistantSinkOptions) {
    this.url = opts.url.replace(/\/$/, '');
    this.token = opts.token;
    this.webhookId = opts.webhookId;
    this.eventType = opts.eventType ?? 'switchbot_event';
  }

  async write(event: MqttSinkEvent): Promise<void> {
    try {
      let endpoint: string;
      const headers: Record<string, string> = { 'content-type': 'application/json' };

      if (this.webhookId) {
        // Webhook mode: no auth needed, HA triggers automations directly
        endpoint = `${this.url}/api/webhook/${this.webhookId}`;
      } else if (this.token) {
        // REST event API: fires a custom event on the HA event bus
        endpoint = `${this.url}/api/events/${this.eventType}`;
        headers['authorization'] = `Bearer ${this.token}`;
      } else {
        console.error('[homeassistant] requires --ha-webhook-id or --ha-token');
        return;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[homeassistant] POST failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[homeassistant] error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
