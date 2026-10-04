import { describe, expect, it } from 'vitest';
import { canonicalToolArguments } from './json-arguments.js';

describe('lossless tool argument comparison', () => {
  it.each([
    ['{"a":1,"b":{"x":[true,null,"value"],"z":2}}', '{ "b": { "z": 2.0, "x": [true, null, "value"] }, "a": 1e0 }'],
    ['{"n":0.0012300}', '{"n":123e-5}'],
    ['{"n":9007199254740993}', '{"n":900719925474099300e-2}'],
    ['{"n":1e999999999}', '{"n":10e999999998}'],
    ['{"n":-0}', '{"n":-0.00e123456}'],
    ['{"\\u0061":"\\u0062","__proto__":{"x":1}}', '{"__proto__":{"x":1},"a":"b"}'],
  ])('matches equivalent JSON without rewriting numeric source (%#)', (first, second) => {
    expect(canonicalToolArguments(first)).toEqual(canonicalToolArguments(second));
  });

  it.each([
    ['9007199254740992', '9007199254740993'],
    ['0.1', '0.10000000000000001'],
    ['1e400', '1e500'],
    ['1e-400', '2e-400'],
    ['0', '-0'],
    ['1', '"1e0"'],
    ['1', '["number","1e0"]'],
  ])('keeps distinct scalar or tagged-looking values separate: %s / %s', (first, second) => {
    expect(canonicalToolArguments(`{"n":${first}}`)).not.toEqual(canonicalToolArguments(`{"n":${second}}`));
  });

  it('matches ordinary parsed arguments with the original JSON wire representation', () => {
    expect(canonicalToolArguments({ n: 1000, nested: { b: 0.125, a: ['quoted"', false, null] } })).toEqual(
      canonicalToolArguments('{"nested":{"a":["quoted\\\"",false,null],"b":125e-3},"n":1e3}'),
    );
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, undefined, 1n])('rejects unsafe parsed-object numeric/unsupported values (%#)', (value) => {
    expect(() => canonicalToolArguments({ value })).toThrow('Invalid call arguments.');
  });

  it('bounds very large exponents without expanding them or merging distinct tokens', () => {
    const exponent = '9'.repeat(10_000);
    const first = `{"n":1e${exponent}}`;
    const second = `{"n":2e${exponent}}`;
    const canonical = canonicalToolArguments(first);
    expect(JSON.stringify(canonical).length).toBeLessThan(first.length + 100);
    expect(canonical).toEqual(canonicalToolArguments(` { "n" : 1e${exponent} } `));
    expect(canonical).not.toEqual(canonicalToolArguments(second));
    expect(canonical).not.toEqual(canonicalToolArguments(`{"n":1.0e${exponent}}`));
  });

  it('compares long string arguments within the existing 8 MiB input budget', () => {
    const value = 'x'.repeat(6 * 1024 * 1024);
    expect(canonicalToolArguments(JSON.stringify({ value }))).toEqual(canonicalToolArguments({ value }));
  });

  it('enforces the same depth bound on strings and parsed objects', () => {
    const within = `{"nested":${'['.repeat(63)}0${']'.repeat(63)}}`;
    const tooDeep = `{"nested":${'['.repeat(64)}0${']'.repeat(64)}}`;
    expect(canonicalToolArguments(within)).toEqual(canonicalToolArguments(JSON.parse(within)));
    expect(() => canonicalToolArguments(tooDeep)).toThrow('Invalid call arguments.');
    expect(() => canonicalToolArguments(JSON.parse(tooDeep))).toThrow('Invalid call arguments.');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalToolArguments(cyclic)).toThrow('Invalid call arguments.');
  });

  it.each(['', '[]', 'null', '1', '"text"', '{', '{"n":01}', '{"n":.1}', '{"n":1.}', '{"n":1e}', '{"n":NaN}', '{"n":truefalse}', '{"n":1,}', '{"n":[1,]}', '{"n":"\\x20"}', '{"n":"line\nbreak"}', '{"n":1}{}', '\u00a0{}'])('rejects malformed or non-object argument text (%#)', (input) => {
    expect(() => canonicalToolArguments(input)).toThrow('Invalid call arguments.');
  });
});
