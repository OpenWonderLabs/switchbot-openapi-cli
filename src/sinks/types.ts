export interface MqttSinkEvent {
  t: string;
  topic: string;
  deviceId: string;
  deviceType: string;
  payload: unknown;
  text: string;
  eventId?: string;
}

export interface Sink {
  write(event: MqttSinkEvent): Promise<void>;
  close?(): Promise<void>;
}
