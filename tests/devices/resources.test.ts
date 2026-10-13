import { describe, it, expect } from 'vitest';
import {
  RESOURCE_CATALOG,
  listWebhookContextDeviceTypes,
  listKeyTypes,
} from '../../src/devices/resources.js';

describe('RESOURCE_CATALOG', () => {
  describe('scenes', () => {
    it('declares documented list and execute REST operations', () => {
      const verbs = RESOURCE_CATALOG.scenes.operations.map((o) => o.verb).sort();
      expect(verbs).toEqual(['execute', 'list']);
    });

    it('list is read-tier GET; execute is mutation POST', () => {
      const list = RESOURCE_CATALOG.scenes.operations.find((o) => o.verb === 'list')!;
      const exec = RESOURCE_CATALOG.scenes.operations.find((o) => o.verb === 'execute')!;
      expect(list.safetyTier).toBe('read');
      expect(list.method).toBe('GET');
      expect(exec.safetyTier).toBe('mutation');
      expect(exec.method).toBe('POST');
    });

    it('execute requires sceneId', () => {
      const operation = RESOURCE_CATALOG.scenes.operations.find((op) => op.verb === 'execute')!;
      const sceneId = operation.params.find((param) => param.name === 'sceneId');
      expect(sceneId).toBeDefined();
      expect(sceneId!.required).toBe(true);
    });
  });

  describe('webhooks', () => {
    it('declares setup / query / update / delete endpoints', () => {
      const verbs = RESOURCE_CATALOG.webhooks.endpoints.map((e) => e.verb).sort();
      expect(verbs).toEqual(['delete', 'query', 'setup', 'update']);
    });

    it('every endpoint is a POST to a /v1.1/webhook/* path', () => {
      for (const ep of RESOURCE_CATALOG.webhooks.endpoints) {
        expect(ep.method).toBe('POST');
        expect(ep.path).toMatch(/^\/v1\.1\/webhook\//);
      }
    });

    it('delete is destructive; setup + update are mutation; query is read', () => {
      const byVerb = Object.fromEntries(
        RESOURCE_CATALOG.webhooks.endpoints.map((e) => [e.verb, e.safetyTier]),
      );
      expect(byVerb.delete).toBe('destructive');
      expect(byVerb.setup).toBe('mutation');
      expect(byVerb.update).toBe('mutation');
      expect(byVerb.query).toBe('read');
    });


    it('places device types and fields inside a changeReport context', () => {
      for (const event of RESOURCE_CATALOG.webhooks.events) {
        expect(event.eventType).toBe('changeReport');
        expect(event.eventVersion).toBe('1');
        expect(event.context.deviceType.length).toBeGreaterThan(0);
        expect(event.context.fields.length).toBeGreaterThan(0);
      }
    });

    it('describes nested webhook fields with supported types', () => {
      const allowed = new Set(['string', 'number', 'boolean', 'timestamp', 'object']);
      for (const event of RESOURCE_CATALOG.webhooks.events) {
        for (const field of event.context.fields) {
          expect(allowed.has(field.type)).toBe(true);
          expect(field.description.length).toBeGreaterThan(0);
          if (field.type === 'object') expect(field.fields?.length).toBeGreaterThan(0);
        }
      }
    });

  });

  describe('keys', () => {
    it('declares 4 key types: permanent, timeLimit, disposable, urgent', () => {
      const types = listKeyTypes().sort();
      expect(types).toEqual(['disposable', 'permanent', 'timeLimit', 'urgent']);
    });

    it('every key type is destructive-tier and lists required params', () => {
      for (const k of RESOURCE_CATALOG.keys) {
        expect(k.safetyTier).toBe('destructive');
        expect(k.requiredParams).toContain('name');
        expect(k.requiredParams).toContain('password');
        expect(k.supportedDevices.length).toBeGreaterThan(0);
      }
    });

    it('timeLimit requires both startTime and endTime', () => {
      const tl = RESOURCE_CATALOG.keys.find((k) => k.keyType === 'timeLimit')!;
      expect(tl.requiredParams).toContain('startTime');
      expect(tl.requiredParams).toContain('endTime');
    });
  });

  describe('helper exports', () => {
    it('listWebhookContextDeviceTypes mirrors the events array', () => {
      expect(listWebhookContextDeviceTypes()).toEqual(
        RESOURCE_CATALOG.webhooks.events.map((e) => e.context.deviceType),
      );
    });
  });
});
