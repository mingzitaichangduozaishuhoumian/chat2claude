import { isDeepStrictEqual } from 'node:util';
import { canonicalToolArguments, ChatGptBackendError } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';

type JsonSourceContext = { source?: string };
type LosslessJson = JSON & { rawJSON?: (source: string) => unknown };

/** Preserve JSON numeric values at the serialization boundary. Ordinary values
 * remain ordinary JavaScript values; only numbers that JSON.stringify would
 * change use native raw JSON primitives. Never rebuild objects by assignment:
 * JSON.parse preserves own __proto__ keys without modifying their prototypes.
 */
export function parseLosslessToolInput(rawArguments: string): Record<string, unknown> {
  const json = JSON as LosslessJson;
  if (typeof json.rawJSON !== 'function') throw unsupportedRuntime();
  const rawJSON = json.rawJSON;
  try {
    const parsed: unknown = JSON.parse(rawArguments, (_key: string, value: unknown, context?: JsonSourceContext) => {
      if (typeof value !== 'number') return value;
      if (typeof context?.source !== 'string') throw unsupportedRuntime();
      const source = context.source;
      if (Number.isFinite(value) && !Object.is(value, -0)) {
        const serialized = JSON.stringify(value);
        if (source === serialized || isDeepStrictEqual(
          canonicalToolArguments(`{"n":${source}}`),
          canonicalToolArguments(`{"n":${serialized}}`),
        )) return value;
      }
      return rawJSON(source);
    });
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ChatGptBackendError || error instanceof ClaudeApiError) throw error;
    throw new ChatGptBackendError('Invalid tool arguments in backend response.', 'invalid_response', { status: 502 });
  }
}

function unsupportedRuntime(): ClaudeApiError {
  return new ClaudeApiError('Lossless tool JSON requires JSON.rawJSON and JSON.parse source context (Node.js 22.15 or newer).', 500, 'api_error');
}
