import { describe, it, expect } from 'vitest';
import { MqttError, classifyMqttConnectError } from '../../src/mqtt/errors.js';
import { buildErrorPayload } from '../../src/utils/output.js';

describe('classifyMqttConnectError', () => {
  it('classifies cert-related errors as mqtt-tls-failed', () => {
    const err = Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' });
    expect(classifyMqttConnectError(err)).toBe('mqtt-tls-failed');
  });

  it('classifies EPROTO as mqtt-tls-failed', () => {
    const err = Object.assign(new Error('protocol error'), { code: 'EPROTO' });
    expect(classifyMqttConnectError(err)).toBe('mqtt-tls-failed');
  });

  it('classifies self-signed cert errors as mqtt-tls-failed', () => {
    const err = Object.assign(new Error('self signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect(classifyMqttConnectError(err)).toBe('mqtt-tls-failed');
  });

  it('defaults to mqtt-connect-timeout for generic connection errors', () => {
    expect(classifyMqttConnectError(new Error('connection refused'))).toBe('mqtt-connect-timeout');
  });

  it('handles non-Error inputs', () => {
    expect(classifyMqttConnectError('string')).toBe('mqtt-connect-timeout');
    expect(classifyMqttConnectError(null)).toBe('mqtt-connect-timeout');
  });
});

describe('buildErrorPayload for MqttError', () => {
  it('produces runtime payload with mqtt subKind and retryable flag', () => {
    const err = new MqttError('TLS handshake failed', 'mqtt-tls-failed', { retryable: true });
    const payload = buildErrorPayload(err);
    expect(payload.kind).toBe('runtime');
    expect(payload.subKind).toBe('mqtt-tls-failed');
    expect(payload.retryable).toBe(true);
    expect(payload.message).toBe('TLS handshake failed');
  });

  it('preserves hint when provided', () => {
    const err = new MqttError('disconnected', 'mqtt-disconnected', {
      retryable: true,
      hint: 'check network',
    });
    const payload = buildErrorPayload(err);
    expect(payload.hint).toBe('check network');
  });

  it('defaults retryable to true for MqttError', () => {
    const err = new MqttError('timed out', 'mqtt-connect-timeout');
    const payload = buildErrorPayload(err);
    expect(payload.retryable).toBe(true);
  });
});
