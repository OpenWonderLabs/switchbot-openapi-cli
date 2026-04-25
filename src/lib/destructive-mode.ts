import { getActiveProfile } from './request-context.js';

const DIRECT_DESTRUCTIVE_PROFILES = new Set(['dev', 'development']);

export function allowsDirectDestructiveExecution(profile = getActiveProfile()): boolean {
  if (process.env.SWITCHBOT_ALLOW_DIRECT_DESTRUCTIVE === '1') return true;
  if (!profile) return false;
  return DIRECT_DESTRUCTIVE_PROFILES.has(profile.toLowerCase());
}

export function destructiveExecutionHint(): string {
  return "Use 'switchbot plan save <file>' -> 'switchbot plan review <planId>' -> 'switchbot plan approve <planId>' -> 'switchbot plan execute <planId>' instead.";
}
