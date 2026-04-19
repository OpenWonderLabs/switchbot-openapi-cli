export type MqttErrorSubKind =
  | 'mqtt-tls-failed'
  | 'mqtt-connect-timeout'
  | 'mqtt-disconnected';

export interface MqttErrorMeta {
  retryable?: boolean;
  hint?: string;
}

export class MqttError extends Error {
  public readonly subKind: MqttErrorSubKind;
  public readonly retryable: boolean;
  public readonly hint?: string;
  constructor(message: string, subKind: MqttErrorSubKind, meta: MqttErrorMeta = {}) {
    super(message);
    this.name = 'MqttError';
    this.subKind = subKind;
    this.retryable = meta.retryable ?? true;
    this.hint = meta.hint;
  }
}

export function classifyMqttConnectError(err: unknown): MqttErrorSubKind {
  if (!(err instanceof Error)) return 'mqtt-connect-timeout';
  const msg = err.message.toLowerCase();
  const code = (err as NodeJS.ErrnoException).code;
  if (
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'EPROTO' ||
    msg.includes('certificate') ||
    msg.includes('tls') ||
    msg.includes('ssl')
  ) {
    return 'mqtt-tls-failed';
  }
  return 'mqtt-connect-timeout';
}
