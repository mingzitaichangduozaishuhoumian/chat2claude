/** Tagged JSON values prevent literal strings/objects from colliding with number tokens. */
export type CanonicalJsonValue =
  | ['null'] | ['boolean', boolean] | ['string', string] | ['number', string]
  | ['array', CanonicalJsonValue[]] | ['object', Array<[string, CanonicalJsonValue]>];

const invalid = () => new Error('Invalid call arguments.');
const MAX_DEPTH = 64;

/** Comparison only: never rewrite the original wire arguments with this value.
 * Parse number tokens without binary floating-point conversion. Parsed object
 * arguments containing unsafe integers cannot establish a lossless match.
 */
export function canonicalToolArguments(value: unknown): CanonicalJsonValue {
  const result = typeof value === 'string' ? parseArguments(value) : canonicalValue(value, 0);
  if (result[0] !== 'object') throw invalid();
  return result;
}

function canonicalValue(value: unknown, depth: number): CanonicalJsonValue {
  if (depth > MAX_DEPTH) throw invalid();
  if (value === null) return ['null'];
  if (typeof value === 'string') return ['string', value];
  if (typeof value === 'boolean') return ['boolean', value];
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) throw invalid();
    return ['number', canonicalNumber(Object.is(value, -0) ? '-0' : String(value))];
  }
  if (Array.isArray(value)) return ['array', value.map((item) => canonicalValue(item, depth + 1))];
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return ['object', Object.keys(value).sort().map((key) => [key, canonicalValue((value as Record<string, unknown>)[key], depth + 1)])];
  }
  throw invalid();
}

/** Bounded recursive descent keeps numeric source text on every supported Node
 * runtime; it does not depend on the newer JSON.parse reviver source argument.
 */
function parseArguments(source: string): CanonicalJsonValue {
  let cursor = 0;
  const strings = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const numbers = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const whitespace = () => { while (cursor < source.length && /[\x20\t\r\n]/.test(source[cursor])) cursor++; };
  const string = (): string => {
    strings.lastIndex = cursor;
    const match = strings.exec(source);
    if (!match) throw invalid();
    cursor = strings.lastIndex;
    return JSON.parse(match[0]) as string;
  };
  const read = (depth: number): CanonicalJsonValue => {
    if (depth > MAX_DEPTH) throw invalid();
    whitespace();
    if (source[cursor] === '"') return ['string', string()];
    if (source[cursor] === '{') {
      cursor++; whitespace();
      const entries = new Map<string, CanonicalJsonValue>();
      if (source[cursor] !== '}') while (true) {
        whitespace();
        const key = string();
        whitespace();
        if (source[cursor++] !== ':') throw invalid();
        entries.set(key, read(depth + 1));
        whitespace();
        if (source[cursor] !== ',') break;
        cursor++;
      }
      if (source[cursor++] !== '}') throw invalid();
      return ['object', [...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)];
    }
    if (source[cursor] === '[') {
      cursor++; whitespace();
      const values: CanonicalJsonValue[] = [];
      if (source[cursor] !== ']') while (true) {
        values.push(read(depth + 1));
        whitespace();
        if (source[cursor] !== ',') break;
        cursor++;
      }
      if (source[cursor++] !== ']') throw invalid();
      return ['array', values];
    }
    for (const [literal, value] of [['null', ['null']], ['true', ['boolean', true]], ['false', ['boolean', false]]] as const) {
      if (source.startsWith(literal, cursor)) { cursor += literal.length; return [...value] as CanonicalJsonValue; }
    }
    numbers.lastIndex = cursor;
    const match = numbers.exec(source);
    if (!match) throw invalid();
    cursor = numbers.lastIndex;
    return ['number', canonicalNumber(match[0])];
  };
  const value = read(0);
  whitespace();
  if (cursor !== source.length) throw invalid();
  return value;
}

function canonicalNumber(token: string): string {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token)!;
  const fraction = match[3] ?? '';
  const digits = (match[2] + fraction).replace(/^0+/, '');
  if (!digits) return match[1] + '0';
  const significant = digits.replace(/0+$/, '');
  const exponent = (match[4] ?? '0').replace(/^([+-]?)0+(?=[0-9])/, '$1');
  // Never expand 10^exponent. Extremely long exponents retain exact spelling
  // to bound parsing cost. This can cause a conservative cache miss or reject
  // a reformatted tool snapshot even when the numbers are mathematically equal.
  if (exponent.replace(/^[+-]/, '').length > 128) return 'raw:' + token;
  const scale = BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - significant.length);
  return match[1] + significant + 'e' + scale.toString();
}
