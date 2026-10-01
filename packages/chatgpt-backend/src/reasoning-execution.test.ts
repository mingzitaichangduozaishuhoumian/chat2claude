import { describe, expect, it } from 'vitest';
import type { ChatGptReasoningExecution } from './client.js';
import { resolveSessionReasoningExecution } from './reasoning-execution.js';

describe('session reasoning execution', () => {
  it.each(['max', 'xhigh', 'Future_Deep', 'future-deep', 'none'])('preserves ordinary provider effort %s', (reasoningEffort) => {
    expect(resolveSessionReasoningExecution({ reasoningEffort })).toEqual({ effort: reasoningEffort });
  });

  it.each(['max', 'xhigh', 'Future_Deep', 'medium'])('executes selected Ultra using resolved effort %s and caller delegation tools', (effort) => {
    const result = resolveSessionReasoningExecution({ reasoningEffort: 'ultra', reasoningExecution: { effort, delegation: 'proactive' } });
    expect(result.effort).toBe(effort);
    expect(result.developerInstructions).toContain('provided by the caller');
    expect(result.developerInstructions).toContain('permissions, and authorization');
    expect(result.developerInstructions).toContain('If no usable delegation tools are provided, complete the task directly.');
  });

  it.each([undefined, null, {}, [], { effort: '' }, { effort: '   ', delegation: 'proactive' }, { effort: 'ultra', delegation: 'proactive' }, { effort: ' ULTRA ', delegation: 'proactive' }, { effort: 1, delegation: 'proactive' }, { effort: 'max', delegation: 'disabled' }])('rejects an invalid Ultra execution plan (%j)', (reasoningExecution) => {
    expect(() => resolveSessionReasoningExecution({ reasoningEffort: 'Ultra', reasoningExecution: reasoningExecution as ChatGptReasoningExecution })).toThrow('Invalid reasoning execution plan');
  });

  it.each([undefined, 'none', 'max', 'Future_Deep'])('rejects an execution plan for non-Ultra selection %s', (reasoningEffort) => {
    expect(() => resolveSessionReasoningExecution({ reasoningEffort, reasoningExecution: { effort: 'max', delegation: 'proactive' } })).toThrow('Invalid reasoning execution plan');
  });
});
