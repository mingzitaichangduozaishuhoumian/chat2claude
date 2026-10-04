import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGptBackendError } from '@chatgpt-to-claude/chatgpt-backend';
import { parseLosslessToolInput } from './lossless-tool-input.js';
import { mapChatGptResponseToClaude } from './response.js';

afterEach(() => vi.restoreAllMocks());

describe('lossless Claude tool input JSON', () => {
  it('serializes extreme numeric tokens without rounding, quoting, overflow, or underflow', () => {
    const source = '{"large":9007199254740993,"decimal":1.0000000000000001,"overflow":1e400,"underflow":1e-400,"negativeZero":-0,"nested":[{"n":-9007199254740993},0.10000000000000001]}';
    expect(JSON.stringify(parseLosslessToolInput(source))).toBe(source);
  });

  it('keeps ordinary JSON input values as normal JavaScript values', () => {
    const expected = { count: 42, ratio: 0.125, exponent: 1000, zero: 0, flags: [true, false, null], nested: { text: '雪', list: [1, 2] } };
    const parsed = parseLosslessToolInput('{"count":42,"ratio":125e-3,"exponent":1e3,"zero":0.0,"flags":[true,false,null],"nested":{"text":"雪","list":[1,2]}}');
    expect(parsed).toEqual(expected);
    expect(typeof parsed.count).toBe('number');
    expect(typeof parsed.ratio).toBe('number');
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(expected));
  });

  it('preserves own __proto__ properties without changing object prototypes', () => {
    const source = '{"__proto__":{"polluted":9007199254740993},"nested":{"__proto__":{"ratio":1.0000000000000001}},"constructor":{"prototype":{"ordinary":true}}}';
    const parsed = parseLosslessToolInput(source);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(parsed.nested)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(JSON.stringify(parsed)).toBe(source);
  });

  it('uses validated source arguments instead of the rounded backend object', () => {
    const rawArguments = '{"id":9007199254740993,"ratio":1.0000000000000001}';
    const response = mapChatGptResponseToClaude({ model: 'model', max_tokens: 32, messages: [] }, {
      text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'lookup', input: JSON.parse(rawArguments), rawArguments }],
    });
    expect(JSON.stringify(response)).toContain(`"input":${rawArguments}`);
  });

  it('leaves backend objects without raw source compatible', () => {
    const input = { count: 2, nested: { value: 0.5 } };
    const response = mapChatGptResponseToClaude({ model: 'model', max_tokens: 32, messages: [] }, {
      text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'lookup', input }],
    });
    expect(response.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'lookup', input }]);
  });

  it('fails explicitly when raw JSON serialization is unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(JSON, 'rawJSON')!;
    Object.defineProperty(JSON, 'rawJSON', { ...descriptor, value: undefined });
    try {
      expect(() => parseLosslessToolInput('{"id":9007199254740993}')).toThrow('JSON.rawJSON');
    } finally { Object.defineProperty(JSON, 'rawJSON', descriptor); }
  });

  it('fails explicitly when JSON.parse does not provide numeric source context', () => {
    const parse = JSON.parse;
    vi.spyOn(JSON, 'parse').mockImplementation((source, reviver) => parse(source, reviver ? function (key, value) { return reviver.call(this, key, value); } : undefined));
    expect(() => parseLosslessToolInput('{"id":9007199254740993}')).toThrow('JSON.parse source context');
  });

  it.each(['{"secret":"PRIVATE_INPUT",}', '[]', 'null'])('rejects invalid source arguments without including their content (%s)', (source) => {
    try {
      parseLosslessToolInput(source);
      throw new Error('Expected source rejection.');
    } catch (error) {
      expect(error).toBeInstanceOf(ChatGptBackendError);
      expect(error).toMatchObject({ code: 'invalid_response', status: 502 });
      expect(String(error)).not.toContain('PRIVATE_INPUT');
    }
  });
});
