import { AsyncLocalStorage } from 'node:async_hooks';
import { getProfile } from '../utils/flags.js';

export interface RequestContext {
  profile?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContext.run(ctx, fn);
}

export function getActiveProfile(): string | undefined {
  const ctx = requestContext.getStore();
  if (ctx?.profile !== undefined) return ctx.profile;
  return getProfile();
}
