import type { ChatGptCompletionRequest } from './client.js';
import { ChatGptBackendError } from './errors.js';

const PROACTIVE_DELEGATION_INSTRUCTIONS = 'Proactive multi-agent delegation is active for this turn. Use delegation or collaboration tools provided by the caller for concrete, independent subtasks when doing so would improve the result. Follow the caller\'s tool schemas, tool-choice restrictions, limits, permissions, and authorization requirements, and respect the user\'s instructions. Do not invent tools or assume that this service provides a subagent runtime. If no usable delegation tools are provided, complete the task directly. Synthesize any delegated results into your response.';

/** Ultra is a local delegation mode; ordinary Responses inference takes its resolved base effort. */
export function resolveSessionReasoningExecution(request: Pick<ChatGptCompletionRequest, 'reasoningEffort' | 'reasoningExecution'>): { effort?: string; developerInstructions?: string } {
  const selected = request.reasoningEffort;
  if (selected !== undefined && typeof selected !== 'string') throw invalidExecution();
  const execution = request.reasoningExecution;
  if (selected?.trim().toLowerCase() !== 'ultra') {
    if (execution !== undefined) throw invalidExecution();
    return selected?.trim() ? { effort: selected } : {};
  }
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)
    || execution.delegation !== 'proactive' || typeof execution.effort !== 'string'
    || !execution.effort.trim() || execution.effort.trim().toLowerCase() === 'ultra') throw invalidExecution();
  return { effort: execution.effort, developerInstructions: PROACTIVE_DELEGATION_INSTRUCTIONS };
}

function invalidExecution(): ChatGptBackendError {
  return new ChatGptBackendError('Invalid reasoning execution plan. Ultra requires a resolved non-ultra effort and proactive delegation.', 'invalid_request', { status: 400 });
}
