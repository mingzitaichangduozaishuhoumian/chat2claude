import { describe, expect, it } from 'vitest';
import type { ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { normalizeReasoningEffort, normalizeSpeedPreference, resolveReasoningSpeed } from './reasoning.js';

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
    }).speedPreference).toBe('fastest');
  });

  it('uses response_speed before model default and global default', () => {
    expect(resolveReasoningSpeed({ ...baseRequest, response_speed: 'quality' }, {
      globalSpeedPreference: 'balanced',
      modelDefaults: { [baseRequest.model]: { speedPreference: 'fast' } },
    }).speedPreference).toBe('quality');
  });

  it('uses model speed default before global default', () => {
    expect(resolveReasoningSpeed(baseRequest, {
      globalSpeedPreference: 'quality',
      modelDefaults: { [baseRequest.model]: { speedPreference: 'fast' } },
    }).speedPreference).toBe('fast');
  });

  it('uses global speed default when no request or model default is present', () => {
    expect(resolveReasoningSpeed(baseRequest, { globalSpeedPreference: 'quality' }).speedPreference).toBe('quality');
  });
});

describe('normalizeReasoningEffort and normalizeSpeedPreference', () => {
  it('falls back for unsupported values without rejecting the request', () => {
    expect(normalizeReasoningEffort('extreme')).toBe('off');
    expect(normalizeSpeedPreference('turbo')).toBe('balanced');
  });
});
