import type { Sink, MqttSinkEvent } from './types.js';

export class StdoutSink implements Sink {
  async write(event: MqttSinkEvent): Promise<void> {
    console.log(JSON.stringify(event));
  }
}
