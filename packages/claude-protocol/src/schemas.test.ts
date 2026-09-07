import { describe, expect, it } from 'vitest';
import { parseClaudeCountTokensRequest, parseClaudeMessagesRequest } from './schemas.js';

describe('parseClaudeMessagesRequest content blocks', () => {
  const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'lookup', input: {} });
  const result = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'HISTORY_CANARY' });
  it.each([
    [{ role: 'user', content: [result('missing')] }],
    [{ role: 'assistant', content: [toolUse('a'), toolUse('a')] }],
    [{ role: 'assistant', content: [toolUse('a')] }, { role: 'user', content: [result('a'), result('a')] }],
    [{ role: 'user', content: [result('a')] }, { role: 'assistant', content: [toolUse('a')] }],
    [{ role: 'user', content: [toolUse('a')] }],
  ])('rejects invalid tool history safely (%j)', (...messages) => {
    expect(() => parseClaudeMessagesRequest({ model: 'sonnet', max_tokens: 64, messages })).toThrow('tool');
    try { parseClaudeMessagesRequest({ model: 'sonnet', max_tokens: 64, messages }); }
    catch (error) { expect(error).toMatchObject({ status: 400 }); expect(String(error)).not.toContain('HISTORY_CANARY'); }
  });

  it('accepts multiple calls/results interleaved with text', () => {
    const messages = [
      { role: 'assistant', content: [toolUse('a'), { type: 'text', text: 'checking' }, toolUse('b')] },
      { role: 'user', content: [result('b'), { type: 'text', text: 'continue' }, result('a')] },
    ];
    expect(parseClaudeMessagesRequest({ model: 'sonnet', max_tokens: 64, messages }).messages).toEqual(messages);
  });

  it.each([
    { type: 'object', properties: { SCHEMA_CANARY: { type: 'string' } } },
    { type: 'object', additionalProperties: false, properties: { SCHEMA_CANARY: { type: 'string' } }, required: [] },
    { type: 'object', additionalProperties: false, properties: { nested: { type: 'array', items: { type: 'object', properties: {} } } }, required: ['nested'] },
    { type: 'object', additionalProperties: false, properties: {}, $defs: { nested: { type: 'object' } } },
  ])('rejects nonconforming strict schema without exposing it', (input_schema) => {
    const input = { model: 'sonnet', max_tokens: 64, messages: [], tools: [{ name: 'lookup', strict: true, input_schema }] };
    expect(() => parseClaudeMessagesRequest(input)).toThrow('strict');
    try { parseClaudeMessagesRequest(input); }
    catch (error) { expect(error).toMatchObject({ status: 400 }); expect(String(error)).not.toContain('SCHEMA_CANARY'); }
    expect(parseClaudeMessagesRequest({ ...input, tools: [{ ...input.tools[0], strict: false }] }).tools?.[0].input_schema).toEqual(input_schema);
  });

  it.each([
    { properties: {}, required: 'SCHEMA_CANARY' },
    { properties: {}, required: [123] },
    { properties: {}, required: undefined },
    { properties: { SCHEMA_CANARY: { type: 'string' } }, required: ['SCHEMA_CANARY', 123] },
    { properties: { SCHEMA_CANARY: { type: 'string' } }, required: ['SCHEMA_CANARY', 'SCHEMA_CANARY'] },
    { properties: { known: { type: 'string' } }, required: ['known', 'SCHEMA_CANARY'] },
  ])('rejects malformed strict required safely (case %#)', (schema) => {
    const input_schema = { type: 'object', additionalProperties: false, ...schema };
    const parse = () => parseClaudeMessagesRequest({ model: 'sonnet', max_tokens: 64, messages: [], tools: [{ name: 'lookup', strict: true, input_schema }] });
    expect(parse).toThrow('strict tool schema requires object schemas with additionalProperties:false and every property in required');
    try { parse(); } catch (error) { expect(String(error)).not.toContain('SCHEMA_CANARY'); }
  });

  it('preserves valid nullable nested strict schema without modifying it', () => {
    const input_schema = { type: 'object', additionalProperties: false, properties: { nested: { type: 'array', items: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {}, required: [] }] } } }, required: ['nested'] };
    expect(parseClaudeMessagesRequest({ model: 'sonnet', max_tokens: 64, messages: [], tools: [{ name: 'lookup', strict: true, input_schema }] }).tools?.[0].input_schema).toEqual(input_schema);
  });

  it('accepts known and unknown content blocks so the mapper can downgrade explicitly', () => {
    const request = parseClaudeMessagesRequest({
      model: 'sonnet',
      max_tokens: 64,
      messages: [{ role: 'user', content: [{ type: 'future_block', value: 1 }] }],
    });
    expect(Array.isArray(request.messages[0].content)).toBe(true);
  });

  it('rejects malformed known content blocks', () => {
    expect(() => parseClaudeMessagesRequest({
      model: 'sonnet',
      max_tokens: 64,
      messages: [{ role: 'user', content: [{ type: 'text' }] }],
    })).toThrow('text block.text must be a string');
  });

  it('lifts misplaced system and developer messages into top-level system instructions', () => {
    const input = {
      model: 'sonnet',
      max_tokens: 64,
      system: 'existing instruction',
      messages: [
        { role: 'system', content: 'system instruction' },
        { role: 'developer', content: [{ type: 'text', text: 'developer instruction' }] },
        { role: 'user', content: 'hello' },
      ],
    };
    const request = parseClaudeMessagesRequest(input);
    expect(request.system).toEqual([
      { type: 'text', text: 'existing instruction' },
      { type: 'text', text: '\n' },
      { type: 'text', text: 'system instruction' },
      { type: 'text', text: '\n' },
      { type: 'text', text: 'developer instruction' },
    ]);
    expect(request.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(input.messages).toHaveLength(3);
  });

  it('rejects non-text content in misplaced system and developer messages', () => {
    expect(() => parseClaudeMessagesRequest({
      model: 'sonnet',
      max_tokens: 64,
      messages: [{ role: 'system', content: [{ type: 'image', source: {} }] }],
    })).toThrow('Unsupported content block type: image');
  });
});

describe('parseClaudeCountTokensRequest', () => {
  it('does not require max_tokens', () => {
    const request = parseClaudeCountTokensRequest({ model: 'sonnet', messages: [{ role: 'user', content: 'hello' }] });
    expect(request.model).toBe('sonnet');
  });

  it('normalizes misplaced developer instructions consistently', () => {
    const request = parseClaudeCountTokensRequest({
      model: 'sonnet',
      messages: [{ role: 'developer', content: 'be concise' }, { role: 'user', content: 'hello' }],
    });
    expect(request.system).toEqual([{ type: 'text', text: 'be concise' }]);
    expect(request.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('rejects invalid count token input', () => {
    expect(() => parseClaudeCountTokensRequest({ messages: [] })).toThrow('model is required');
    expect(() => parseClaudeCountTokensRequest({ model: 'sonnet', messages: 'bad' })).toThrow('messages must be an array');
    expect(() => parseClaudeCountTokensRequest({ model: 'sonnet', max_tokens: 0, messages: [] })).toThrow('max_tokens must be a positive number');
    expect(() => parseClaudeCountTokensRequest({ model: 'sonnet', tools: {}, messages: [] })).toThrow('tools must be an array');
  });
});
