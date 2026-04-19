import type { Sink, MqttSinkEvent } from './types.js';

export class SinkDispatcher {
  private sinks: Sink[];

  constructor(sinks: Sink[]) {
    this.sinks = sinks;
  }

  async dispatch(event: MqttSinkEvent): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => s.write(event)));
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => s.close?.()));
  }
}
