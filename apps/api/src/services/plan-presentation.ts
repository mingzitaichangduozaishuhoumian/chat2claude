export interface PlanPresentation {
  label: string;
  upstreamId: string | null;
  source: 'usage' | 'oauth' | 'unknown';
  stale: boolean;
}

/** Only explicit upstream plan claims are inputs; never routing or usage meters. */
export function presentPlan(usage?: { status: string; quota?: { planType?: string }; expiresAt?: string | null }, oauthPlanType?: string): PlanPresentation {
  // This function is also serialized for Admin; avoid loader-decorated local functions.
  const validId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
  const usagePlanType = usage?.quota?.planType;
  const usageId = typeof usagePlanType === 'string' && validId.test(usagePlanType) ? usagePlanType : undefined;
  const oauthId = typeof oauthPlanType === 'string' && validId.test(oauthPlanType) ? oauthPlanType : undefined;
  const upstreamId = usageId ?? oauthId ?? null;
  const labels: Record<string, string> = { plus: 'ChatGPT Plus', prolite: 'ChatGPT Pro 5x', pro: 'ChatGPT Pro 20x' };
  return {
    label: upstreamId ? (Object.prototype.hasOwnProperty.call(labels, upstreamId) ? labels[upstreamId] : upstreamId) : 'Plan unknown',
    upstreamId,
    source: usageId ? 'usage' : upstreamId ? 'oauth' : 'unknown',
    stale: Boolean(usageId && (usage?.status !== 'fresh' || (usage.expiresAt && Date.parse(usage.expiresAt) <= Date.now()))),
  };
}

export function planPresentationText(plan: PlanPresentation): string {
  return `${plan.label}${plan.upstreamId ? ` · ${plan.upstreamId}` : ''} · ${plan.source}${plan.stale ? '（陈旧观察）' : ''}`;
}
