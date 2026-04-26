import { expect } from 'vitest';

export function expectJsonEnvelopeShape(
  payload: Record<string, unknown>,
  dataKeys: string[],
): Record<string, unknown> {
  expect(Object.keys(payload)).toEqual(['schemaVersion', 'data']);
  const data = payload.data as Record<string, unknown>;
  expect(Object.keys(data)).toEqual(dataKeys);
  return data;
}

export function expectJsonEnvelopeContainingKeys(
  payload: Record<string, unknown>,
  requiredDataKeys: string[],
): Record<string, unknown> {
  expect(Object.keys(payload)).toEqual(['schemaVersion', 'data']);
  const data = payload.data as Record<string, unknown>;
  expect(Object.keys(data)).toEqual(expect.arrayContaining(requiredDataKeys));
  return data;
}

export function expectStreamHeaderShape(
  header: Record<string, unknown>,
  eventKind: 'tick' | 'event',
  cadence: 'poll' | 'push',
): void {
  expect(header.schemaVersion).toBe('1.1');
  expect(header.stream).toBe(true);
  expect(header.eventKind).toBe(eventKind);
  expect(header.cadence).toBe(cadence);
  expect(Object.keys(header)).toEqual(['schemaVersion', 'stream', 'eventKind', 'cadence']);
}
