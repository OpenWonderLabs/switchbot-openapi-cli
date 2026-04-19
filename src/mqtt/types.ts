export interface MqttCredential {
  brokerUrl: string;
  clientId: string;
  topics: string[];
  tls: {
    caBase64: string;
    certBase64: string;
    keyBase64: string;
  };
  qos: number;
  expiresAt: number;
}

export interface DeviceShadowEvent {
  ts: string;
  deviceId: string;
  deviceType: string;
  payload: Record<string, unknown>;
}

export interface StreamFilter {
  type?: string;
  deviceId?: string;
}
