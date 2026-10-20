import { canonicalToolArguments, type ChatGptInputContentPart, type ChatGptInputItem } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import type { OpenAiResponsesInputItem } from '@chatgpt-to-claude/protocol-mapper';

function invalid(): never { throw new ClaudeApiError('History cannot be continued on a different backend until all tools complete and only supported visible content remains.', 400, 'invalid_request_error'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 256) return invalid(); return value; }
function complete(value: Record<string, unknown>): void { if (value.status !== undefined && value.status !== 'completed') invalid(); }
function argumentsValue(value: unknown): unknown {
  try { canonicalToolArguments(value); return structuredClone(value); } catch { return invalid(); }
}

/** Public tool contracts survive handoff; provider replay, message IDs and execution metadata do not. */
export function visibleInputHistory(input: readonly ChatGptInputItem[]): ChatGptInputItem[] {
  const result: ChatGptInputItem[] = [];
  const seen = new Set<string>();
  const pending = new Set<string>();
  for (const raw of input) {
    const item = object(raw);
    if (item.type === 'replay') {
      const replay = object(item.item);
      complete(replay);
      if (replay.type === 'reasoning') continue;
      if (replay.type !== 'function_call' || replay.async === true || replay.namespace !== undefined
        || replay.caller !== undefined && replay.caller !== null && object(replay.caller).type !== 'direct') invalid();
      const callId = identifier(replay.call_id);
      const name = identifier(replay.name);
      if (seen.has(callId)) invalid();
      seen.add(callId); pending.add(callId);
      result.push({ type: 'function_call', callId, name, arguments: argumentsValue(replay.arguments) });
    } else if (raw.type === 'message') {
      if (pending.size) invalid();
      if (!['user', 'assistant', 'system'].includes(raw.role)) invalid();
      result.push({ type: 'message', role: raw.role, content: publicContent(raw.content) });
    } else if (raw.type === 'function_call') {
      const callId = identifier(raw.callId);
      if (seen.has(callId)) invalid();
      const name = identifier(raw.name);
      seen.add(callId); pending.add(callId);
      result.push({ type: 'function_call', callId, name, arguments: argumentsValue(raw.arguments) });
    } else if (raw.type === 'function_call_output') {
      const callId = identifier(raw.callId);
      if (!pending.delete(callId)) invalid();
      result.push({ type: 'function_call_output', callId, output: publicContent(raw.output), ...(raw.isError === undefined ? {} : { isError: raw.isError }) });
    } else invalid();
  }
  if (pending.size) invalid();
  return result;
}

function publicContent(value: unknown): string | ChatGptInputContentPart[] {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return invalid();
  return value.map((raw) => {
    const part = object(raw);
    if (part.type === 'text' && typeof part.text === 'string') return { type: 'text' as const, text: part.text };
    if (part.type !== 'image' || typeof part.imageUrl !== 'string' || !part.imageUrl
      || part.detail !== undefined && !['auto', 'low', 'high'].includes(part.detail as string)) return invalid();
    return { type: 'image' as const, imageUrl: part.imageUrl, ...(part.detail === undefined ? {} : { detail: part.detail as 'auto' | 'low' | 'high' }) };
  });
}

/** Strictly project only known native Responses items; no ciphertext or provider identities leave this boundary. */
export function visibleResponsesHistory(input: readonly OpenAiResponsesInputItem[]): OpenAiResponsesInputItem[] {
  const canonical: ChatGptInputItem[] = [];
  for (const raw of input) {
    const item = object(raw);
    complete(item);
    if (item.type === 'reasoning') continue;
    if (item.type === 'message' || item.type === undefined && typeof item.role === 'string') {
      if (!['user', 'assistant', 'system', 'developer'].includes(String(item.role))) invalid();
      canonical.push({ type: 'message', role: item.role === 'developer' ? 'system' : item.role as 'user' | 'assistant' | 'system', content: responseContent(item.content) });
    } else if (item.type === 'function_call') {
      if (item.async === true || item.namespace !== undefined
        || item.caller !== undefined && item.caller !== null && object(item.caller).type !== 'direct') invalid();
      canonical.push({ type: 'function_call', callId: identifier(item.call_id), name: identifier(item.name), arguments: item.arguments });
    } else if (item.type === 'function_call_output') {
      canonical.push({ type: 'function_call_output', callId: identifier(item.call_id), output: responseContent(item.output) });
    } else invalid();
  }
  return visibleInputHistory(canonical).map((item): OpenAiResponsesInputItem => {
    if (item.type === 'message') return { type: 'message', role: item.role, content: wireContent(item.content) };
    if (item.type === 'function_call') return { type: 'function_call', call_id: item.callId, name: item.name,
      arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments) };
    if (item.type === 'function_call_output') return { type: 'function_call_output', call_id: item.callId, output: wireContent(item.output) };
    return invalid();
  });
}

function responseContent(value: unknown): string | ChatGptInputContentPart[] {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return invalid();
  return value.map((raw): ChatGptInputContentPart => {
    const part = object(raw);
    if (['input_text', 'output_text', 'text'].includes(String(part.type)) && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part.type === 'refusal' && typeof part.refusal === 'string') return { type: 'text', text: part.refusal };
    const nested = part.image_url !== null && typeof part.image_url === 'object' ? object(part.image_url) : undefined;
    const url = typeof part.image_url === 'string' ? part.image_url : nested?.url;
    const detail = part.detail ?? nested?.detail;
    if (!['input_image', 'image_url'].includes(String(part.type)) || typeof url !== 'string' || !url
      || detail !== undefined && !['auto', 'low', 'high'].includes(detail as string)) return invalid();
    return { type: 'image', imageUrl: url, ...(detail === undefined ? {} : { detail: detail as 'auto' | 'low' | 'high' }) };
  });
}
function wireContent(content: string | ChatGptInputContentPart[]): unknown {
  return typeof content === 'string' ? content : content.map((part) => part.type === 'text'
    ? { type: 'input_text', text: part.text } : { type: 'input_image', image_url: part.imageUrl, ...(part.detail === undefined ? {} : { detail: part.detail }) });
}
