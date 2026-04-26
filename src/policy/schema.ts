import { readPolicySchemaJson } from '../embedded-assets.js';

export type PolicySchemaVersion = '0.2';

export const SUPPORTED_POLICY_SCHEMA_VERSIONS: PolicySchemaVersion[] = ['0.2'];
export const CURRENT_POLICY_SCHEMA_VERSION: PolicySchemaVersion = '0.2';

const schemaCache = new Map<PolicySchemaVersion, object>();

export function loadPolicySchema(version: PolicySchemaVersion = CURRENT_POLICY_SCHEMA_VERSION): object {
  const cached = schemaCache.get(version);
  if (cached) return cached;

  const raw = readPolicySchemaJson(version);
  const parsed = JSON.parse(raw) as object;
  schemaCache.set(version, parsed);
  return parsed;
}

export function isSupportedPolicySchemaVersion(v: unknown): v is PolicySchemaVersion {
  return typeof v === 'string' && (SUPPORTED_POLICY_SCHEMA_VERSIONS as string[]).includes(v);
}
