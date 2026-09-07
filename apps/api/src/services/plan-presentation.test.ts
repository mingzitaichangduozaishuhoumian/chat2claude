import { describe, expect, it } from 'vitest';
import { planPresentationText, presentPlan } from './plan-presentation.js';

describe('safe plan presentation', () => {
  it.each([['plus', 'ChatGPT Plus'], ['prolite', 'ChatGPT Pro 5x'], ['pro', 'ChatGPT Pro 20x'], ['future_plan', 'future_plan'], ['constructor', 'constructor']])('preserves explicit %s plan identity', (id, label) => {
    expect(presentPlan(undefined, id)).toEqual({ upstreamId: id, label, source: 'oauth', stale: false });
  });
  it.each([['prolite', 'ChatGPT Pro 5x'], ['pro', 'ChatGPT Pro 20x']])('uses the mapped %s product label without exposing its raw ID in user-facing plan text', (id, label) => {
    expect(planPresentationText(presentPlan(undefined, id))).toBe(label);
  });
  it('prioritizes fresh then stale usage observations over OAuth', () => {
    expect(presentPlan({ status: 'fresh', quota: { planType: 'prolite' } }, 'pro')).toMatchObject({ label: 'ChatGPT Pro 5x', source: 'usage', stale: false });
    expect(presentPlan({ status: 'stale', quota: { planType: 'plus' } }, 'pro')).toMatchObject({ label: 'ChatGPT Plus', source: 'usage', stale: true });
    expect(presentPlan({ status: 'fresh', expiresAt: '2000-01-01T00:00:00Z', quota: { planType: 'plus' } }, 'pro').stale).toBe(true);
    expect(presentPlan({ status: 'error' }, 'pro')).toMatchObject({ label: 'ChatGPT Pro 20x', source: 'oauth' });
  });
  it('does not expose arbitrary payloads or infer a plan from absent claims', () => {
    for (const value of ['<script>alert(1)</script>', 'eyJ.token.signature', 'Bearer token', 'x'.repeat(100)]) expect(presentPlan(undefined, value)).toMatchObject({ upstreamId: null, source: 'unknown' });
    expect(presentPlan({ status: 'fresh', quota: {} })).toMatchObject({ label: 'Plan unknown' });
  });
});
