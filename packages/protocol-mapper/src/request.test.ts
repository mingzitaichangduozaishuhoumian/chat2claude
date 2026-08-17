import { describe, expect, it } from 'vitest';
import type { ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { flattenCanonicalContentForTextBackend, mapClaudeRequestToChatGpt, normalizeClaudeMessagesToCanonical } from './request.js';

const base = (content: ClaudeMessagesRequest['messages'][number]['content']): ClaudeMessagesRequest => ({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content }] });

describe('canonical request mapping', () => {
  it('keeps string and text blocks as backend text', () => {
    expect(mapClaudeRequestToChatGpt(base('hello')).messages[0].content).toBe('hello');
    expect(mapClaudeRequestToChatGpt(base([{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }])).messages[0].content).toBe('hello world');
  });

  it('prepends string system as the first backend message without reordering user messages', () => {
    const mapped = mapClaudeRequestToChatGpt({
      model: 'sonnet',
      max_tokens: 64,
      system: 'Always answer tersely.',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
    });

    expect(mapped.messages).toEqual([
      { role: 'system', content: 'Always answer tersely.' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('concatenates structured system text blocks', () => {
    const mapped = mapClaudeRequestToChatGpt({
      ...base('hello'),
      system: [{ type: 'text', text: 'Be ' }, { type: 'text', text: 'concise.' }],
    });

    expect(mapped.messages[0]).toEqual({ role: 'system', content: 'Be concise.' });
    expect(mapped.messages[1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('keeps unsupported structured system blocks explicit instead of dropping them', () => {
    const mapped = mapClaudeRequestToChatGpt({
      ...base('hello'),
      system: [{ type: 'text', text: 'Use this ' }, { type: 'future_system_block', payload: 1 } as never],
    });

    expect(mapped.messages[0]).toEqual({ role: 'system', content: 'Use this [unsupported:future_system_block]' });
    expect(mapped.backendOptions?.mappingDiagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unsupported_content_block', path: 'system[1]' })]));
  });

  it('preserves tool_result content instead of silently dropping it', () => {
    const request = base([{ type: 'tool_result', tool_use_id: 'toolu_1', content: '72F' }]);
    const mapped = mapClaudeRequestToChatGpt(request);
    expect(mapped.messages[0].content).toContain('[tool_result:toolu_1] 72F');
  });

  it('downgrades image blocks with explicit placeholder and diagnostic', () => {
    const request = base([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaa' } }]);
    const canonical = normalizeClaudeMessagesToCanonical(request);
    const text = flattenCanonicalContentForTextBackend(canonical.messages[0].content, canonical.diagnostics);
    expect(text).toBe('[unsupported:image]');
    expect(canonical.diagnostics.map((item) => item.code)).toContain('image_text_backend_placeholder');
  });

  it('downgrades tool_use blocks with explicit placeholder', () => {
    const request = base([{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }]);
    expect(mapClaudeRequestToChatGpt(request).messages[0].content).toBe('[unsupported:tool_use:get_weather]');
  });

  it('keeps unknown blocks explicit instead of dropping them', () => {
    const request = base([{ type: 'future_block', payload: 1 }]);
    const mapped = mapClaudeRequestToChatGpt(request);
    expect(mapped.messages[0].content).toBe('[unsupported:future_block]');
    expect(mapped.backendOptions?.mappingDiagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unsupported_content_block' })]));
  });

  it('maps Claude tools and tool_choice to backend tool request fields', () => {
    const mapped = mapClaudeRequestToChatGpt({
      ...base('use a tool'),
      tools: [{ name: 'get_weather', description: 'weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } }, strict: true }],
      tool_choice: { type: 'tool', name: 'get_weather' },
    });
    expect(mapped.tools).toEqual([{ name: 'get_weather', description: 'weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } }, strict: true, raw: expect.any(Object) }]);
    expect(mapped.toolChoice).toEqual({ type: 'tool', name: 'get_weather' });
  });
});
