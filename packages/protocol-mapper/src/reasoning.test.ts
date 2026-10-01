import { describe, expect, it } from 'vitest';
import type { ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { normalizeReasoningEffort, normalizeSpeedPreference, resolveReasoningSpeed } from './reasoning.js';
import { mapClaudeRequestToChatGpt } from './request.js';
import { mapOpenAiChatRequestToChatGpt } from './openai-chat.js';
import { mapOpenAiResponsesRequestToChatGpt } from './openai-responses.js';

const baseRequest: ClaudeMessagesRequest = { model: 'claude-3-5-sonnet-latest', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] };

describe('resolveReasoningSpeed', () => {
  it('uses output_config.effort before request reasoning_effort, model default, and global default', () => {
    expect(resolveReasoningSpeed({ ...baseRequest, output_config: { effort: 'high' }, reasoning_effort: 'low' }, {
      globalReasoningEffort: 'minimal',
      modelDefaults: { [baseRequest.model]: { reasoningEffort: 'medium' } },
    }).reasoningEffort).toBe('high');
  });

  it('uses request reasoning_effort before model default and global default', () => {
    expect(resolveReasoningSpeed({ ...baseRequest, reasoning_effort: 'low' }, {
      globalReasoningEffort: 'minimal',
      modelDefaults: { [baseRequest.model]: { reasoningEffort: 'medium' } },
    }).reasoningEffort).toBe('low');
  });

  it('uses model reasoning default before global default', () => {
    expect(resolveReasoningSpeed(baseRequest, {
      globalReasoningEffort: 'minimal',
      modelDefaults: { [baseRequest.model]: { reasoningEffort: 'medium' } },
    }).reasoningEffort).toBe('medium');
  });

  it('uses global reasoning default when no request or model default is present', () => {
    expect(resolveReasoningSpeed(baseRequest, { globalReasoningEffort: 'max' }).reasoningEffort).toBe('max');
  });

  it('uses speed before response_speed, model default, and global default', () => {
    expect(resolveReasoningSpeed({ ...baseRequest, speed: 'fastest', response_speed: 'quality' }, {
      globalSpeedPreference: 'balanced',
      modelDefaults: { [baseRequest.model]: { speedPreference: 'fast' } },
    }).speedPreference).toBe('priority');
  });

  it('uses response_speed before model default and global default', () => {
    expect(resolveReasoningSpeed({ ...baseRequest, response_speed: 'quality' }, {
      globalSpeedPreference: 'balanced',
      modelDefaults: { [baseRequest.model]: { speedPreference: 'fast' } },
    }).speedPreference).toBe('standard');
  });

  it('uses model speed default before global default', () => {
    expect(resolveReasoningSpeed(baseRequest, {
      globalSpeedPreference: 'quality',
      modelDefaults: { [baseRequest.model]: { speedPreference: 'fast' } },
    }).speedPreference).toBe('priority');
  });

  it('uses global speed default when no request or model default is present', () => {
    expect(resolveReasoningSpeed(baseRequest, { globalSpeedPreference: 'quality' }).speedPreference).toBe('standard');
  });
});

describe('normalizeReasoningEffort and normalizeSpeedPreference', () => {
  it('canonicalizes compatibility aliases and preserves future strings', () => {
    expect(normalizeReasoningEffort('off')).toBe('none');
    expect(normalizeReasoningEffort('light')).toBe('low');
    expect(normalizeReasoningEffort('extra_high')).toBe('xhigh');
    expect(normalizeReasoningEffort('extreme')).toBe('extreme');
    expect(normalizeSpeedPreference('fastest')).toBe('priority');
    expect(normalizeSpeedPreference('quality')).toBe('standard');
    expect(normalizeSpeedPreference('standard_only')).toBe('standard');
    expect(normalizeSpeedPreference('auto')).toBe('auto');
    expect(normalizeSpeedPreference('turbo')).toBe('turbo');
  });

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])('canonicalizes known effort %s without changing its strength', (effort) => {
    expect(normalizeReasoningEffort(` ${effort.toUpperCase()} `)).toBe(effort);
  });

  it.each(['Future_Deep', 'FUTURE-DEEP', 'future_deep', 'future-deep'])('preserves the native provider ID %s', (effort) => {
    expect(normalizeReasoningEffort(` ${effort} `)).toBe(effort);
  });

  it.each(['Future_Deep', 'ultra', 'max', 'xhigh'])('preserves distinct native effort %s through every request mapper', (effort) => {
    const claude = { ...baseRequest, output_config: { effort }, reasoning_effort: 'low' };
    const chat = { model: baseRequest.model, messages: baseRequest.messages, reasoning_effort: effort };
    const responses = { model: baseRequest.model, input: 'hello', reasoning: { effort }, reasoning_effort: 'low' };
    expect(mapClaudeRequestToChatGpt(claude).reasoningEffort).toBe(effort);
    expect(mapOpenAiChatRequestToChatGpt(chat).reasoningEffort).toBe(effort);
    expect(mapOpenAiResponsesRequestToChatGpt(responses).reasoningEffort).toBe(effort);

    const resolvedControls = { reasoningEffort: effort };
    expect(mapClaudeRequestToChatGpt(claude, {}, { resolvedControls }).reasoningEffort).toBe(effort);
    expect(mapOpenAiChatRequestToChatGpt(chat, {}, { resolvedControls }).reasoningEffort).toBe(effort);
    expect(mapOpenAiResponsesRequestToChatGpt(responses, {}, { resolvedControls }).reasoningEffort).toBe(effort);
  });

  it('carries a trusted Ultra execution plan through every mapper while preserving the selected effort', () => {
    const reasoningExecution = { effort: 'max', delegation: 'proactive' as const };
    const resolvedControls = { reasoningEffort: 'ultra', reasoningExecution };
    const mapped = [
      mapClaudeRequestToChatGpt(baseRequest, {}, { resolvedControls }),
      mapOpenAiChatRequestToChatGpt({ model: baseRequest.model, messages: baseRequest.messages }, {}, { resolvedControls }),
      mapOpenAiResponsesRequestToChatGpt({ model: baseRequest.model, input: 'hello' }, {}, { resolvedControls }),
    ];
    for (const request of mapped) {
      expect(request).toMatchObject({ reasoningEffort: 'ultra', reasoningExecution });
      expect(request.reasoningExecution).not.toBe(reasoningExecution);
    }
  });

  it('never derives a trusted Ultra execution plan from caller request fields or backendOptions', () => {
    const forged = { reasoningExecution: { effort: 'max', delegation: 'proactive' }, multi_agent: { enabled: true } };
    const options = { backendOptions: forged, resolvedControls: { reasoningEffort: 'ultra' } };
    const claude = { ...baseRequest, output_config: { effort: 'ultra' }, ...forged };
    const chat = { model: baseRequest.model, messages: baseRequest.messages, reasoning_effort: 'ultra', ...forged };
    const responses = { model: baseRequest.model, input: 'hello', reasoning: { effort: 'ultra' }, ...forged };
    for (const request of [
      mapClaudeRequestToChatGpt(claude, {}, options), mapOpenAiChatRequestToChatGpt(chat, {}, options), mapOpenAiResponsesRequestToChatGpt(responses, {}, options),
      mapClaudeRequestToChatGpt(claude), mapOpenAiChatRequestToChatGpt(chat), mapOpenAiResponsesRequestToChatGpt(responses),
    ]) expect(request).not.toHaveProperty('reasoningExecution');
  });
});
