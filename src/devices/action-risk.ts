/** Semantic repeat safety is independent of whether a transport accepts a deduplication key. */
export function decideActionRisk(tier: 'read' | 'action' | 'destructive', idempotent?: boolean | null) {
  const repeatSafe = tier === 'read' ? true : idempotent ?? null;
  return {
    idempotent: repeatSafe,
    idempotencyHint: repeatSafe === null ? 'caution' : repeatSafe ? 'safe' : 'non-idempotent',
    requiresConfirmation: tier === 'destructive',
    riskLevel: tier === 'destructive' ? 'high' : tier === 'action' ? 'medium' : 'low',
    recommendedMode: tier === 'destructive' ? 'review-before-execute' : tier === 'action' ? 'plan' : 'direct',
  } as const;
}
