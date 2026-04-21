import { describe, it, expect } from 'vitest';
import {
  RESOURCE_CATALOG,
  listWebhookEventTypes,
  listKeyTypes,
} from '../../src/devices/resources.js';

describe('RESOURCE_CATALOG', () => {
  describe('scenes', () => {
    it('declares list / execute / describe operations', () => {
      const verbs = RESOURCE_CATALOG.scenes.operations.map((o) => o.verb).sort();
      expect(verbs).toEqual(['describe', 'execute', 'list']);
    });

    it('list is read-tier GET; execute is mutation POST', () => {
      const list = RESOURCE_CATALOG.scenes.operations.find((o) => o.verb === 'list')!;
      const exec = RESOURCE_CATALOG.scenes.operations.find((o) => o.verb === 'execute')!;
      expect(list.safetyTier).toBe('read');
      expect(list.method).toBe('GET');
      expect(exec.safetyTier).toBe('mutation');
      expect(exec.method).toBe('POST');
    });

    it('execute + describe both require sceneId', () => {
      for (const verb of ['execute', 'describe'] as const) {
        const op = RESOURCE_CATALOG.scenes.operations.find((o) => o.verb === verb)!;
        const sceneId = op.params.find((p) => p.name === 'sceneId');
        expect(sceneId, `${verb} should declare sceneId param`).toBeDefined();
        expect(sceneId!.required).toBe(true);
      }
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

    it('exposes ~15 event types covering the common device surface', () => {
      const events = RESOURCE_CATALOG.webhooks.events;
      expect(events.length).toBeGreaterThanOrEqual(10);
      const types = events.map((e) => e.eventType);
      for (const wanted of ['WoMeter', 'WoPresence', 'WoContact', 'WoLock', 'WoPlug', 'WoDoorbell', 'WoKeypad']) {
        expect(types, `missing webhook event ${wanted}`).toContain(wanted);
      }
    });

    it('every event declares deviceType, deviceMac, timeOfSample', () => {
      for (const ev of RESOURCE_CATALOG.webhooks.events) {
        const names = ev.fields.map((f) => f.name);
        expect(names, `${ev.eventType} missing deviceType`).toContain('deviceType');
        expect(names, `${ev.eventType} missing deviceMac`).toContain('deviceMac');
        expect(names, `${ev.eventType} missing timeOfSample`).toContain('timeOfSample');
      }
    });

    it('every field has a non-empty description + valid type', () => {
      const allowed = new Set(['string', 'number', 'boolean', 'timestamp']);
      for (const ev of RESOURCE_CATALOG.webhooks.events) {
        for (const f of ev.fields) {
          expect(allowed.has(f.type), `${ev.eventType}.${f.name} has invalid type ${f.type}`).toBe(true);
          expect(f.description.length).toBeGreaterThan(0);
        }
      }
    });

    it('constraints expose URL + per-account limits', () => {
      expect(RESOURCE_CATALOG.webhooks.constraints.maxUrlLength).toBeGreaterThan(0);
      expect(RESOURCE_CATALOG.webhooks.constraints.maxWebhooksPerAccount).toBeGreaterThan(0);
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
    it('listWebhookEventTypes mirrors the events array', () => {
      expect(listWebhookEventTypes()).toEqual(
        RESOURCE_CATALOG.webhooks.events.map((e) => e.eventType),
      );
    });
  });
});
