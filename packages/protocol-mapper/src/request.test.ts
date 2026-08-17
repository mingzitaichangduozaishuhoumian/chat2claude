import { describe, expect, it } from 'vitest';
import type { ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { flattenCanonicalContentForTextBackend, mapClaudeRequestToChatGpt, normalizeClaudeMessagesToCanonical } from './request.js';
import { mapOpenAiChatRequestToChatGpt } from './openai-chat.js';
import { mapOpenAiResponsesRequestToChatGpt } from './openai-responses.js';

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

  it('maps Claude base64 image blocks to structured inputItems while keeping text fallback', () => {
    const mapped = mapClaudeRequestToChatGpt(base([{ type: 'text', text: 'see ' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaa' } }, { type: 'text', text: ' done' }]));

    expect(mapped.messages[0].content).toBe('see [unsupported:image] done');
    expect(mapped.inputItems).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'see ' }, { type: 'image', imageUrl: 'data:image/png;base64,aaa' }, { type: 'text', text: ' done' }] },
    ]);
  });

  it('maps Claude tool_use and tool_result blocks to structured inputItems while keeping text fallback', () => {
    const mapped = mapClaudeRequestToChatGpt({
      model: 'sonnet',
      max_tokens: 64,
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '72F' }], is_error: true }] },
      ],
    });
    expect(mapped.messages).toEqual([
      { role: 'assistant', content: 'checking[unsupported:tool_use:get_weather]' },
      { role: 'user', content: '[tool_result:toolu_1:error] 72F' },
    ]);
    expect(mapped.inputItems).toEqual([
      { type: 'message', role: 'assistant', content: 'checking' },
      { type: 'function_call', callId: 'toolu_1', name: 'get_weather', arguments: { city: 'Paris' } },
      { type: 'function_call_output', callId: 'toolu_1', output: '72F', isError: true },
    ]);
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

  it('preserves selected Claude top-level request fields in backend options with diagnostics', () => {
    const metadata = { user_id: 'user_123' };
    const container = { id: 'container_123' };
    const contextManagement = { edits: 'clear' };
    const mcpServers = [{ type: 'url', url: 'https://mcp.example.test' }];
    const mapped = mapClaudeRequestToChatGpt({
      ...base('body text'),
      metadata,
      service_tier: 'auto',
      container,
      context_management: contextManagement,
      mcp_servers: mcpServers,
    });

    expect(mapped.backendOptions?.claudeRequest).toEqual({
      metadata,
      service_tier: 'auto',
      container,
      context_management: contextManagement,
      mcp_servers: mcpServers,
    });
    expect(mapped.backendOptions?.mappingDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'claude_request_field_preserved', path: 'metadata' }),
      expect.objectContaining({ code: 'claude_request_field_preserved', path: 'service_tier' }),
      expect.objectContaining({ code: 'claude_request_field_preserved', path: 'container' }),
      expect.objectContaining({ code: 'claude_request_field_preserved', path: 'context_management' }),
      expect.objectContaining({ code: 'claude_request_field_preserved', path: 'mcp_servers' }),
    ]));
    expect(mapped.messages).toEqual([{ role: 'user', content: 'body text' }]);
    expect(mapped.messages[0].content).not.toContain('user_123');
    expect(mapped.messages[0].content).not.toContain('service_tier');
    expect(mapped.messages[0].content).not.toContain('container_123');
    expect(mapped.messages[0].content).not.toContain('mcp.example.test');
  });

  it('does not create an empty claudeRequest backend option for ordinary Claude requests', () => {
    const mapped = mapClaudeRequestToChatGpt(base('hello'));

    expect(mapped.backendOptions).not.toHaveProperty('claudeRequest');
  });

  it('maps Claude generation controls to backend request fields', () => {
    const mapped = mapClaudeRequestToChatGpt({
      ...base('tune generation'),
      temperature: 0.25,
      top_p: 0.75,
      stop_sequences: ['END', 'STOP'],
    });

    expect(mapped.temperature).toBe(0.25);
    expect(mapped.topP).toBe(0.75);
    expect(mapped.stopSequences).toEqual(['END', 'STOP']);
  });
});

describe('OpenAI request generation controls mapping', () => {
  it('maps chat temperature, top_p, and string stop to backend request fields', () => {
    const mapped = mapOpenAiChatRequestToChatGpt({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
      top_p: 0.8,
      stop: 'END',
    });

    expect(mapped.temperature).toBe(0.2);
    expect(mapped.topP).toBe(0.8);
    expect(mapped.stopSequences).toEqual(['END']);
  });

  it('maps chat stop arrays to backend stopSequences', () => {
    const mapped = mapOpenAiChatRequestToChatGpt({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      stop: ['END', 'STOP'],
    });

    expect(mapped.stopSequences).toEqual(['END', 'STOP']);
  });

  it('maps Responses temperature, top_p, and stop arrays to backend request fields', () => {
    const mapped = mapOpenAiResponsesRequestToChatGpt({
      model: 'gpt-test',
      input: 'hello',
      temperature: 0.3,
      top_p: 0.9,
      stop: ['END', 'STOP'],
    });

    expect(mapped.temperature).toBe(0.3);
    expect(mapped.topP).toBe(0.9);
    expect(mapped.stopSequences).toEqual(['END', 'STOP']);
  });


  it('maps OpenAI chat text and image_url content parts to structured inputItems', () => {
    const mapped = mapOpenAiChatRequestToChatGpt({
      model: 'gpt-test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look ' }, { type: 'image_url', image_url: { url: 'https://example.test/a.png', detail: 'high' } }] }],
    });

    expect(mapped.messages).toEqual([{ role: 'user', content: 'look [unsupported:image_url]' }]);
    expect(mapped.inputItems).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'look ' }, { type: 'image', imageUrl: 'https://example.test/a.png', detail: 'high' }] },
    ]);
  });

  it('maps OpenAI chat assistant tool_calls and tool messages to structured inputItems', () => {
    const mapped = mapOpenAiChatRequestToChatGpt({
      model: 'gpt-test',
      messages: [
        { role: 'assistant', content: 'checking', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
        { role: 'assistant', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'fallback', arguments: 'not-json' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
      ],
    });

    expect(mapped.messages).toEqual([
      { role: 'assistant', content: 'checking\n[tool_call:call_1:get_weather] {"city":"Paris"}' },
      { role: 'assistant', content: '[tool_call:call_2:fallback] not-json' },
      { role: 'user', content: '[tool_result:call_1] sunny' },
    ]);
    expect(mapped.inputItems).toEqual([
      { type: 'message', role: 'assistant', content: 'checking' },
      { type: 'function_call', callId: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } },
      { type: 'function_call', callId: 'call_2', name: 'fallback', arguments: 'not-json' },
      { type: 'function_call_output', callId: 'call_1', output: 'sunny' },
    ]);
  });

  it('maps OpenAI Responses function_call and function_call_output to structured inputItems', () => {
    const mapped = mapOpenAiResponsesRequestToChatGpt({
      model: 'gpt-test',
      instructions: 'be concise',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: { q: 'x' } },
        { type: 'function_call_output', call_id: 'call_1', output: 'done' },
      ],
    });

    expect(mapped.messages).toEqual([
      { role: 'system', content: 'be concise' },
      { role: 'user', content: 'hello' },
      { role: 'user', content: '[function_call:call_1:lookup] {"q":"x"}' },
      { role: 'user', content: '[function_call_output:call_1] done' },
    ]);
    expect(mapped.inputItems).toEqual([
      { type: 'message', role: 'system', content: 'be concise' },
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'function_call', callId: 'call_1', name: 'lookup', arguments: { q: 'x' } },
      { type: 'function_call_output', callId: 'call_1', output: 'done' },
    ]);
  });

  it('maps OpenAI Responses input_image content parts to structured inputItems', () => {
    const mapped = mapOpenAiResponsesRequestToChatGpt({
      model: 'gpt-test',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look ' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,bbb', detail: 'low' }] }],
    });

    expect(mapped.messages).toEqual([{ role: 'user', content: 'look [unsupported:input_image]' }]);
    expect(mapped.messages[0].content).not.toContain('base64');
    expect(mapped.messages[0].content).not.toContain('data:image');
    expect(mapped.inputItems).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'look ' }, { type: 'image', imageUrl: 'data:image/jpeg;base64,bbb', detail: 'low' }] },
    ]);
  });

  it('maps Responses string stop to a single backend stop sequence', () => {
    const mapped = mapOpenAiResponsesRequestToChatGpt({
      model: 'gpt-test',
      input: 'hello',
      stop: 'END',
    });

    expect(mapped.stopSequences).toEqual(['END']);
  });

  it('maps Responses compatibility fields to backend responsesBody', () => {
    const text = { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' } } };
    const mapped = mapOpenAiResponsesRequestToChatGpt({
      model: 'gpt-test',
      input: 'hello',
      previous_response_id: 'resp_prev',
      store: true,
      metadata: { trace: 'abc' },
      parallel_tool_calls: false,
      truncation: 'auto',
      text,
      response_format: { type: 'json_object' },
    }, {}, { backendOptions: { keep: true, responsesBody: { existing: 'ok' } } });

    expect(mapped.backendOptions).toEqual({
      keep: true,
      responsesBody: {
        existing: 'ok',
        previous_response_id: 'resp_prev',
        store: true,
        metadata: { trace: 'abc' },
        parallel_tool_calls: false,
        truncation: 'auto',
        text,
      },
    });
  });

  it('flattens Responses response_format json_schema into text.format when text is absent', () => {
    const responseFormat = { type: 'json_schema', json_schema: { name: 'answer', description: 'answer schema', schema: { type: 'object' }, strict: true } };
    const mapped = mapOpenAiResponsesRequestToChatGpt({ model: 'gpt-test', input: 'hello', response_format: responseFormat });

    expect(mapped.backendOptions?.responsesBody).toEqual({ text: { format: { type: 'json_schema', name: 'answer', description: 'answer schema', schema: { type: 'object' }, strict: true } } });
  });

  it('keeps Responses response_format json_object unchanged and merges existing text options', () => {
    const responseFormat = { type: 'json_object' };
    const mapped = mapOpenAiResponsesRequestToChatGpt(
      { model: 'gpt-test', input: 'hello', response_format: responseFormat },
      {},
      { backendOptions: { responsesBody: { text: { verbosity: 'low' } } } }
    );

    expect(mapped.backendOptions?.responsesBody).toEqual({ text: { verbosity: 'low', format: responseFormat } });
  });

  it('does not let Responses response_format overwrite an existing text.format', () => {
    const existingFormat = { type: 'text' };
    const mapped = mapOpenAiResponsesRequestToChatGpt(
      { model: 'gpt-test', input: 'hello', response_format: { type: 'json_object' } },
      {},
      { backendOptions: { responsesBody: { text: { format: existingFormat } } } }
    );

    expect(mapped.backendOptions?.responsesBody).toEqual({ text: { format: existingFormat } });
  });

  it('maps Chat response_format json_object to backend responsesBody text.format unchanged', () => {
    const responseFormat = { type: 'json_object' };
    const mapped = mapOpenAiChatRequestToChatGpt({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      response_format: responseFormat,
    }, {}, { backendOptions: { keep: true } });

    expect(mapped.backendOptions).toEqual({ keep: true, responsesBody: { text: { format: responseFormat } } });
  });

  it('flattens Chat response_format json_schema into backend responsesBody text.format', () => {
    const mapped = mapOpenAiChatRequestToChatGpt({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' }, strict: false } },
    });

    expect(mapped.backendOptions?.responsesBody).toEqual({ text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: false } } });
  });

  it('does not let Chat response_format overwrite an existing text.format', () => {
    const existingFormat = { type: 'text' };
    const mapped = mapOpenAiChatRequestToChatGpt({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      response_format: { type: 'json_object' },
    }, {}, { backendOptions: { responsesBody: { text: { format: existingFormat } } } });

    expect(mapped.backendOptions?.responsesBody).toEqual({ text: { format: existingFormat } });
  });
});
