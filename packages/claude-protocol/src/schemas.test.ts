import { describe, expect, it } from 'vitest';
import { parseClaudeCountTokensRequest, parseClaudeMessagesRequest } from './schemas.js';

describe('parseClaudeMessagesRequest content blocks', () => {
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
