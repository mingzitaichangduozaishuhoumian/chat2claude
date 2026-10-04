import { isDeepStrictEqual } from 'node:util';
import type { ChatGptCompletionRequest, ChatGptCompletionResponse, ChatGptImageDetail, ChatGptImageGenerationCallOutputItem, ChatGptInputContentPart, ChatGptInputItem, ChatGptMessage, ChatGptReasoningExecution, ChatGptStreamEvent, ChatGptTool, ChatGptToolChoice, ChatGptUsage } from '@chatgpt-to-claude/chatgpt-backend';
import { ChatGptBackendError, parseResponsesReplayItem, ResponsesReplayBudget, RESPONSES_INPUT_REPLAY_LIMITS } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import { createMessageId } from '@chatgpt-to-claude/shared';
import { estimateTokens } from './response.js';
import { normalizeReasoningEffort, normalizeSpeedPreference, type ReasoningSpeedDefaults } from './reasoning.js';
import { imageReferences, NativeImageBudget, NativePreviewBudget, type ImagePartial } from './generated-images.js';

export interface OpenAiResponsesRequest {
  model: string;
  input: string | OpenAiResponsesInputItem[];
  instructions?: string;
  include?: Array<'reasoning.encrypted_content'>;
  stream?: boolean;
  max_output_tokens?: number;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[] | null;
  reasoning?: { effort?: string };
  reasoning_effort?: string;
  service_tier?: string;
  speed?: string;
  response_speed?: string;
  tools?: OpenAiResponsesTool[];
  tool_choice?: OpenAiResponsesToolChoice;
  previous_response_id?: string | null;
  store?: boolean | null;
  metadata?: Record<string, unknown> | null;
  parallel_tool_calls?: boolean;
  truncation?: string;
  text?: Record<string, unknown>;
  response_format?: Record<string, unknown>;
}

export type OpenAiResponsesInputItem = Record<string, unknown>;
export type OpenAiResponsesTool = Record<string, unknown>;
export type OpenAiResponsesToolChoice = 'auto' | 'none' | 'required' | { type?: string; name?: string; function?: { name?: string } };

export interface OpenAiResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  model: string;
  status: 'completed';
  output: Array<Record<string, unknown>>;
  output_text: string;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

export interface OpenAiResponsesBackendRequestOptions {
  backendModel?: string;
  backendOptions?: Record<string, unknown>;
  resolvedControls?: { reasoningEffort?: string; reasoningExecution?: ChatGptReasoningExecution; serviceTier?: string };
}

export function mapOpenAiResponsesRequestToChatGpt(request: OpenAiResponsesRequest, defaults: ReasoningSpeedDefaults = {}, options: OpenAiResponsesBackendRequestOptions = {}): ChatGptCompletionRequest {
  const modelDefaults = defaults.modelDefaults?.[request.model];
  const stopSequences = normalizeResponsesStop(request.stop);
  const backendOptions = mapResponsesBackendOptions(request, options.backendOptions);
  return {
    messages: mapResponsesInput(request.input, request.instructions),
    inputItems: mapResponsesInputItems(request.input, request.instructions),
    maxTokens: request.max_output_tokens ?? request.max_tokens ?? 1024,
    model: options.backendModel ?? request.model,
    ...(options.resolvedControls
      ? {
          ...(options.resolvedControls.reasoningEffort === undefined ? {} : { reasoningEffort: options.resolvedControls.reasoningEffort }),
          ...(options.resolvedControls.reasoningExecution === undefined ? {} : { reasoningExecution: { ...options.resolvedControls.reasoningExecution } }),
          ...(options.resolvedControls.serviceTier === undefined ? {} : { serviceTier: options.resolvedControls.serviceTier }),
        }
      : {
          reasoningEffort: normalizeReasoningEffort(request.reasoning?.effort ?? request.reasoning_effort ?? modelDefaults?.reasoningEffort ?? defaults.globalReasoningEffort),
          speedPreference: normalizeSpeedPreference(request.service_tier ?? request.speed ?? request.response_speed ?? modelDefaults?.speedPreference ?? defaults.globalSpeedPreference),
        }),
    temperature: typeof request.temperature === 'number' ? request.temperature : undefined,
    topP: typeof request.top_p === 'number' ? request.top_p : undefined,
    stopSequences,
    tools: mapResponsesTools(request.tools),
    toolChoice: mapResponsesToolChoice(request.tool_choice),
    backendOptions,
  };
}

function mapResponsesBackendOptions(request: OpenAiResponsesRequest, backendOptions: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const responsesBody: Record<string, unknown> = isPlainObject(backendOptions?.responsesBody) ? { ...(backendOptions.responsesBody as Record<string, unknown>) } : {};
  for (const key of ['previous_response_id', 'metadata', 'parallel_tool_calls', 'truncation'] as const) {
    if (request[key] !== undefined) responsesBody[key] = request[key];
  }
  if (request.text !== undefined) responsesBody.text = request.text;
  else if (request.response_format !== undefined) {
    const text = isPlainObject(responsesBody.text) ? { ...(responsesBody.text as Record<string, unknown>) } : {};
    if (text.format === undefined) responsesBody.text = { ...text, format: normalizeOpenAiResponseFormat(request.response_format) };
  }
  const rawTools = mapResponsesRawHostedTools(request.tools);
  if (rawTools?.length) responsesBody.tools = Array.isArray(responsesBody.tools) ? [...responsesBody.tools, ...rawTools] : rawTools;
  const rawToolChoice = mapResponsesRawHostedToolChoice(request.tool_choice);
  if (rawToolChoice) responsesBody.tool_choice = rawToolChoice;
  if (!Object.keys(responsesBody).length) return backendOptions;
  return { ...backendOptions, responsesBody };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mapResponsesRawHostedTools(tools: OpenAiResponsesTool[] | undefined): OpenAiResponsesTool[] | undefined {
  if (!tools) return undefined;
  const rawTools = tools.filter((tool) => tool.type !== undefined && tool.type !== 'function').map((tool) => ({ ...tool }));
  return rawTools.length ? rawTools : undefined;
}

function mapResponsesRawHostedToolChoice(toolChoice: OpenAiResponsesToolChoice | undefined): Record<string, unknown> | undefined {
  if (!toolChoice || typeof toolChoice !== 'object' || toolChoice.type === 'function') return undefined;
  return { ...toolChoice };
}

function normalizeOpenAiResponseFormat(responseFormat: Record<string, unknown>): Record<string, unknown> {
  if (responseFormat.type !== 'json_schema') return responseFormat;
  const jsonSchema = responseFormat.json_schema;
  if (!isPlainObject(jsonSchema)) return responseFormat;
  return { type: 'json_schema', ...jsonSchema };
}

export function mapChatGptResponseToOpenAiResponses(request: OpenAiResponsesRequest, response: ChatGptCompletionResponse): OpenAiResponsesResponse {
  if (response.terminalSuccessful === false) throw invalidNativeOutput();
  const imageBudget = new NativeImageBudget();
  const hasNativeMessage = response.outputItems?.some((item) => item.type === 'message') ?? false;
  const outputText = hasNativeMessage ? response.outputItems!.filter((item) => item.type === 'message').flatMap((item) => item.content.map((part) => part.type === 'output_text' ? part.text : '')).join('') : response.text ?? '';
  const refusal = response.refusal ?? '';
  const fallbackContent: Array<Record<string, unknown>> = [
    ...(outputText ? [{ type: 'output_text', text: outputText, annotations: [] }] : []),
    ...(refusal ? [{ type: 'refusal', refusal }] : []),
  ];
  if (!fallbackContent.length) fallbackContent.push({ type: 'output_text', text: '', annotations: [] });
  const fallbackMessage = { id: `msg_${createMessageId()}`, type: 'message', role: 'assistant', status: 'completed', content: fallbackContent };
  const output: Array<Record<string, unknown>> = [];
  const replay = response.replayItems ?? [];
  if (outputText || refusal || !response.toolCalls?.length && !replay.length) output.push(fallbackMessage);
  for (const raw of replay) {
    const item = parseResponsesReplayItem(raw);
    if (!item) throw invalidNativeOutput();
    const visible: Record<string, unknown> = { ...item };
    if (!request.include?.includes('reasoning.encrypted_content')) delete visible.encrypted_content;
    if (!visible.id) visible.id = `fc_${createMessageId()}`;
    output.push(visible);
  }
  const replayCalls = new Set(replay.filter((item) => item.type === 'function_call').map((item) => item.call_id));
  for (const toolCall of response.toolCalls ?? []) if (!replayCalls.has(toolCall.id)) output.push({ id: `fc_${createMessageId()}`, type: 'function_call', status: 'completed', call_id: toolCall.id, name: toolCall.name, arguments: toolCall.rawArguments ?? JSON.stringify(toolCall.input ?? {}) });
  if (response.outputItems) {
    const imageIds = new Set<string>();
    const nativeOutput = response.outputItems.map((item): Record<string, unknown> => {
      if (item.type === 'image_generation_call') {
        if (imageIds.has(item.id)) throw invalidNativeOutput();
        imageIds.add(item.id);
      }
      const visible: Record<string, unknown> = { ...structuredClone(item.type === 'image_generation_call' ? imageBudget.add(item) : item) };
      if (!request.include?.includes('reasoning.encrypted_content')) delete visible.encrypted_content;
      visible.id ??= `${item.type === 'message' ? 'msg' : item.type === 'image_generation_call' ? 'img' : 'fc'}_${createMessageId()}`;
      return visible;
    });
    output.splice(0, output.length, ...(hasNativeMessage || !outputText && !refusal
      ? nativeOutput
      : [fallbackMessage, ...nativeOutput]));
  }
  const inputTokens = response.usage?.inputTokens ?? estimateTokens(JSON.stringify(request.input));
  const outputTokens = response.usage?.outputTokens ?? estimateTokens(outputText + refusal + JSON.stringify(response.toolCalls ?? []));
  const totalTokens = response.usage?.totalTokens ?? inputTokens + outputTokens;
  return {
    id: createResponsesId(),
    object: 'response',
    created_at: currentUnixSeconds(),
    model: request.model,
    status: 'completed',
    output,
    output_text: outputText,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens },
  };
}

export interface OpenAiResponsesStreamOptions {
  signal?: AbortSignal;
  onCompleted?: (response: OpenAiResponsesResponse, completion: ChatGptCompletionResponse) => void | Promise<void>;
}

export const NATIVE_RESPONSES_OUTPUT_BYTES = 4 * 1024 * 1024;
function invalidNativeOutput(): ChatGptBackendError {
  return new ChatGptBackendError('Invalid Responses backend output.', 'invalid_response', { status: 502 });
}

export async function* mapChatGptStreamToOpenAiResponsesSse(request: OpenAiResponsesRequest, events: AsyncIterable<ChatGptStreamEvent>, options: OpenAiResponsesStreamOptions = {}): AsyncIterable<string> {
  const id = createResponsesId();
  const createdAt = currentUnixSeconds();
  let sequence = 0;
  const emit = (type: string, fields: Record<string, unknown>) => {
    options.signal?.throwIfAborted();
    return responsesSse(type, { type, sequence_number: sequence++, ...fields });
  };
  yield emit('response.created', { response: { ...createMinimalResponse(id, createdAt, request.model, [], ''), status: 'in_progress' } });
  let terminal: Extract<ChatGptStreamEvent, { type: 'done' }> | undefined;
  let text = '';
  let refusal = '';
  let bytes = 256; // Fixed counters/array state, independent of discarded envelopes.
  const lastCodeUnit = { text_delta: 0, refusal_delta: 0 };
  const toolCalls: NonNullable<ChatGptCompletionResponse['toolCalls']> = [];
  const pendingImages: ChatGptImageGenerationCallOutputItem[] = [];
  const imageBudget = new NativeImageBudget();
  const previewBudget = new NativePreviewBudget();
  const imagePreviews = new Map<string, { outputIndex: number; publishedIndex?: number; buffered: ImagePartial[] }>();
  const imageAddedByIndex = new Map<number, string>();
  const output: Array<Record<string, unknown>> = [];
  let textOutput: Record<string, unknown> | undefined;
  let textOpen = false;
  const contentIndexes = new Map<'text_delta' | 'refusal_delta', number>();
  type LiveMessage = { id: string; publishedIndex?: number; parts: Map<number, { type: 'text_delta' | 'refusal_delta'; text: string; published: boolean }> };
  const identifiedMessages = new Map<number, LiveMessage>();
  const addedIndexes = new Set<number>();
  const doneIndexes = new Set<number>();
  const publishedSnapshots = new Map<number, Record<string, unknown>>();
  const emitImageAdded = function* (itemId: string, output_index: number) {
    if (imageAddedByIndex.get(output_index) === itemId) return;
    if (addedIndexes.has(output_index) || output_index !== addedIndexes.size) throw invalidNativeOutput();
    addedIndexes.add(output_index);
    imageAddedByIndex.set(output_index, itemId);
    yield emit('response.output_item.added', { output_index, item: { type: 'image_generation_call', id: itemId, status: 'in_progress', result: null } });
  };
  const emitImagePartial = (partial: ImagePartial, output_index: number) => emit('response.image_generation_call.partial_image', {
    item_id: partial.itemId, output_index, partial_image_index: partial.partialImageIndex,
    partial_image_b64: partial.partialImageB64, ...partial.metadata,
  });
  const emitFinalItem = function* (item: Record<string, unknown>, output_index: number) {
    if (item.type === 'image_generation_call') {
      const preview = imagePreviews.get(item.id as string);
      if (preview?.publishedIndex !== undefined && preview.publishedIndex !== output_index) throw invalidNativeOutput();
      yield* emitImageAdded(item.id as string, output_index);
      for (const partial of preview?.buffered ?? []) yield emitImagePartial(partial, output_index);
      if (preview) preview.buffered = [];
    } else {
      if (addedIndexes.has(output_index) || output_index !== addedIndexes.size) throw invalidNativeOutput();
      const initial: Record<string, unknown> = { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : item.type === 'message' ? { content: [] } : {}) };
      delete initial.encrypted_content;
      addedIndexes.add(output_index);
      yield emit('response.output_item.added', { output_index, item: initial });
    }
    const fields = { item_id: item.id, output_index };
    if (item.type === 'function_call') {
      yield emit('response.function_call_arguments.delta', { ...fields, delta: item.arguments });
      yield emit('response.function_call_arguments.done', { ...fields, arguments: item.arguments });
    } else if (item.type === 'message') {
      const content = item.content as Array<Record<string, unknown>>;
      for (const [content_index, part] of content.entries()) {
        const isRefusal = part.type === 'refusal';
        yield emit('response.content_part.added', { ...fields, content_index, part: { ...part, ...(isRefusal ? { refusal: '' } : { text: '' }) } });
        yield emit(isRefusal ? 'response.refusal.delta' : 'response.output_text.delta', { ...fields, content_index, delta: isRefusal ? part.refusal : part.text });
        yield emit(isRefusal ? 'response.refusal.done' : 'response.output_text.done', { ...fields, content_index, ...(isRefusal ? { refusal: part.refusal } : { text: part.text }) });
        yield emit('response.content_part.done', { ...fields, content_index, part });
      }
    } else if (item.type === 'image_generation_call' && item.status === 'completed') {
      yield emit('response.image_generation_call.completed', fields);
    }
    doneIndexes.add(output_index);
    yield emit('response.output_item.done', { output_index, item });
  };
  const publishPrefix = function* (event: { projectedOutputIndex?: number; projectedOutputPrefix?: unknown[] }): Generator<string, number | undefined> {
    if (event.projectedOutputIndex === undefined) return undefined;
    if (!Number.isSafeInteger(event.projectedOutputIndex) || event.projectedOutputPrefix?.length !== event.projectedOutputIndex) throw invalidNativeOutput();
    for (const [index, raw] of event.projectedOutputPrefix.entries()) {
      const parsed = parseResponsesReplayItem(raw);
      if (!parsed || parsed.type !== 'reasoning') throw invalidNativeOutput();
      const item: Record<string, unknown> = { ...parsed };
      if (!request.include?.includes('reasoning.encrypted_content')) delete item.encrypted_content;
      const previous = publishedSnapshots.get(index);
      if (previous) { if (!isDeepStrictEqual(previous, item)) throw invalidNativeOutput(); }
      else {
        bytes += Buffer.byteLength(JSON.stringify(item), 'utf8');
        if (bytes > NATIVE_RESPONSES_OUTPUT_BYTES) throw invalidNativeOutput();
        publishedSnapshots.set(index, item);
        yield* emitFinalItem(item, index);
      }
    }
    return event.projectedOutputIndex;
  };
  const finalizeIncrementalText = function* (finalItem?: Record<string, unknown>) {
    if (!textOutput || !textOpen) return;
    const output_index = output.indexOf(textOutput);
    const content = [...contentIndexes].map(([type]) => type === 'refusal_delta'
      ? { type: 'refusal', refusal } : { type: 'output_text', text, annotations: [] });
    const completed = finalItem ?? { ...textOutput, content, status: 'completed' };
    for (const [content_index, part] of content.entries()) {
      const fields = { item_id: textOutput.id, output_index, content_index };
      yield emit(part.type === 'refusal' ? 'response.refusal.done' : 'response.output_text.done', { ...fields, ...(part.type === 'refusal' ? { refusal } : { text }) });
      yield emit('response.content_part.done', { ...fields, part });
    }
    output[output_index] = completed;
    doneIndexes.add(output_index);
    yield emit('response.output_item.done', { output_index, item: completed });
    textOpen = false;
  };
  const finalizeIdentifiedMessage = function* (item: Record<string, unknown>, output_index: number, live: LiveMessage, sourceIndices?: number[]) {
    if (item.type !== 'message' || item.id !== live.id || !Array.isArray(item.content)) throw invalidNativeOutput();
    // The safe projection can omit unsupported content parts. Match the original
    // stream identities through backend metadata, never by equal text values.
    const indices = sourceIndices ?? item.content.map((_part, index) => index);
    if (indices.length !== item.content.length || indices.some((index, position) => !Number.isSafeInteger(index) || index < 0 || position > 0 && index <= indices[position - 1])) throw invalidNativeOutput();
    const projectedIndices = new Map(indices.map((sourceIndex, index) => [sourceIndex, index]));
    const projectedParts = new Map([...live.parts].map(([sourceIndex, part]) => {
      const index = projectedIndices.get(sourceIndex);
      if (index === undefined) throw invalidNativeOutput();
      return [index, part] as const;
    }));
    for (const [index, part] of live.parts) if (part.published && indices[index] !== index) throw invalidNativeOutput();
    if (live.publishedIndex !== undefined && live.publishedIndex !== output_index) throw invalidNativeOutput();
    // Omitted provider items may precede this message. Until the final safe
    // projection is known, their raw indices cannot be exposed as client indices.
    if (live.publishedIndex === undefined) {
      for (const [index, previous] of projectedParts) {
        const part = item.content[index] as Record<string, unknown>;
        const value = previous.type === 'refusal_delta' ? part.refusal : part.text;
        if (part.type !== (previous.type === 'refusal_delta' ? 'refusal' : 'output_text') || typeof value !== 'string' || !value.startsWith(previous.text)) throw invalidNativeOutput();
      }
      yield* emitFinalItem(item, output_index);
      return;
    }
    for (const [content_index, raw] of item.content.entries()) {
      const part = raw as Record<string, unknown>;
      const isRefusal = part.type === 'refusal';
      const type = isRefusal ? 'refusal_delta' : 'text_delta';
      const value = isRefusal ? part.refusal : part.text;
      if (typeof value !== 'string') throw invalidNativeOutput();
      const previous = projectedParts.get(content_index);
      if (previous && (previous.type !== type || !value.startsWith(previous.text))) throw invalidNativeOutput();
      const fields = { item_id: live.id, output_index, content_index };
      if (!previous?.published) yield emit('response.content_part.added', { ...fields, part: { ...part, ...(isRefusal ? { refusal: '' } : { text: '' }) } });
      const remaining = value.slice(previous?.published ? previous.text.length : 0);
      if (remaining) yield emit(isRefusal ? 'response.refusal.delta' : 'response.output_text.delta', { ...fields, delta: remaining });
      yield emit(isRefusal ? 'response.refusal.done' : 'response.output_text.done', { ...fields, ...(isRefusal ? { refusal: value } : { text: value }) });
      yield emit('response.content_part.done', { ...fields, part });
    }
    doneIndexes.add(output_index);
    yield emit('response.output_item.done', { output_index, item });
  };
  for await (const event of events) {
    options.signal?.throwIfAborted();
    if (terminal) throw invalidNativeOutput();
    if (event.type === 'image_partial') {
      const partial = previewBudget.add(event);
      if ([...identifiedMessages.values()].some((message) => message.id === partial.itemId) || identifiedMessages.has(partial.outputIndex)) throw invalidNativeOutput();
      let preview = imagePreviews.get(partial.itemId);
      if (!preview) {
        const hintedIndex = textOutput ? undefined : yield* publishPrefix(event);
        const precedingArePublished = partial.outputIndex === addedIndexes.size;
        const publishedIndex = textOutput ? undefined : hintedIndex ?? (precedingArePublished ? partial.outputIndex : undefined);
        preview = { outputIndex: partial.outputIndex, ...(publishedIndex === undefined ? {} : { publishedIndex }), buffered: [] };
        imagePreviews.set(partial.itemId, preview);
        if (publishedIndex !== undefined) yield* emitImageAdded(partial.itemId, publishedIndex);
      }
      if (preview.publishedIndex === undefined) preview.buffered.push(partial);
      else yield emitImagePartial(partial, preview.publishedIndex);
    } else if (event.type === 'text_delta' || event.type === 'refusal_delta') {
      bytes += Buffer.byteLength(event.text, 'utf8');
      // A surrogate pair can straddle chunks: two isolated replacements cost six
      // UTF-8 bytes, whereas the concatenated code point costs four.
      const first = event.text.charCodeAt(0);
      const previous = lastCodeUnit[event.type];
      if (previous >= 0xd800 && previous <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) bytes -= 2;
      if (event.text.length) lastCodeUnit[event.type] = event.text.charCodeAt(event.text.length - 1);
      // Completed snapshots already carry authoritative item IDs and order. If
      // no live message was sent, publish those items together at the terminal.
      if (event.finalSnapshot && !textOutput) {
        if (event.type === 'refusal_delta') refusal += event.text;
        else text += event.text;
        if (bytes > NATIVE_RESPONSES_OUTPUT_BYTES) throw invalidNativeOutput();
        continue;
      }
      if (event.itemId !== undefined && event.outputIndex !== undefined && event.contentIndex !== undefined) {
        if (textOutput) throw invalidNativeOutput();
        const { itemId, outputIndex, contentIndex } = event;
        if (imagePreviews.has(itemId) || [...imagePreviews.values()].some((preview) => preview.outputIndex === outputIndex)) throw invalidNativeOutput();
        let live = identifiedMessages.get(outputIndex);
        if (!live) {
          if ([...identifiedMessages.values()].some((message) => message.id === itemId)) throw invalidNativeOutput();
          const hintedIndex = yield* publishPrefix(event);
          const precedingArePublished = outputIndex === 0 || addedIndexes.size >= outputIndex
            && [...addedIndexes].filter((index) => index < outputIndex).length === outputIndex;
          const publishedIndex = hintedIndex ?? (precedingArePublished ? outputIndex : undefined);
          if (publishedIndex !== undefined && [...identifiedMessages.values()].some((message) => message.publishedIndex === publishedIndex)) throw invalidNativeOutput();
          live = { id: itemId, ...(publishedIndex !== undefined ? { publishedIndex } : {}), parts: new Map() };
          identifiedMessages.set(outputIndex, live);
          bytes += Buffer.byteLength(itemId, 'utf8') + 64;
          if (live.publishedIndex !== undefined) {
            addedIndexes.add(live.publishedIndex);
            yield emit('response.output_item.added', { output_index: live.publishedIndex, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
          }
        }
        if (live.id !== itemId) throw invalidNativeOutput();
        const isRefusal = event.type === 'refusal_delta';
        let part = live.parts.get(contentIndex);
        if (!part) {
          const published = live.publishedIndex !== undefined && contentIndex === [...live.parts.values()].filter((part) => part.published).length;
          part = { type: event.type, text: '', published };
          live.parts.set(contentIndex, part);
          bytes += 64;
          if (part.published) yield emit('response.content_part.added', { item_id: itemId, output_index: live.publishedIndex, content_index: contentIndex, part: isRefusal ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] } });
        }
        if (part.type !== event.type) throw invalidNativeOutput();
        part.text += event.text;
        if (isRefusal) refusal += event.text;
        else text += event.text;
        if (part.published) yield emit(isRefusal ? 'response.refusal.delta' : 'response.output_text.delta', { item_id: itemId, output_index: live.publishedIndex, content_index: contentIndex, delta: event.text });
        if (bytes > NATIVE_RESPONSES_OUTPUT_BYTES) throw invalidNativeOutput();
        continue;
      }
      if (!textOutput && imagePreviews.size) {
        if (event.type === 'refusal_delta') refusal += event.text;
        else text += event.text;
        if (bytes > NATIVE_RESPONSES_OUTPUT_BYTES) throw invalidNativeOutput();
        continue;
      }
      if (identifiedMessages.size) throw invalidNativeOutput();
      if (!textOutput) {
        textOutput = { id: `msg_${createMessageId()}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
        output.push(textOutput);
        addedIndexes.add(output.length - 1);
        yield emit('response.output_item.added', { output_index: output.length - 1, item: textOutput });
        textOpen = true;
      }
      const isRefusal = event.type === 'refusal_delta';
      let contentIndex = contentIndexes.get(event.type);
      if (contentIndex === undefined) {
        contentIndex = contentIndexes.size;
        contentIndexes.set(event.type, contentIndex);
        const part = isRefusal ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] };
        yield emit('response.content_part.added', { item_id: textOutput.id, output_index: output.indexOf(textOutput), content_index: contentIndex, part });
      }
      if (isRefusal) refusal += event.text;
      else text += event.text;
      yield emit(isRefusal ? 'response.refusal.delta' : 'response.output_text.delta', { item_id: textOutput.id, output_index: output.indexOf(textOutput), content_index: contentIndex, delta: event.text });
    } else if (event.type === 'tool_call') {
      const argumentsText = event.toolCall.rawArguments ?? JSON.stringify(event.toolCall.input ?? {});
      bytes += Buffer.byteLength(argumentsText, 'utf8') + Buffer.byteLength(event.toolCall.name, 'utf8') + event.toolCall.id.length;
      toolCalls.push(event.toolCall);
    } else if (event.type === 'image_output') {
      pendingImages.push(imageBudget.add(event.item));
    } else if (event.type === 'done') {
      for (const item of event.outputItems ?? []) if (item.type === 'image_generation_call') imageBudget.add(item);
      bytes += Buffer.byteLength(JSON.stringify({ ...event, ...(event.outputItems ? { outputItems: imageReferences(event.outputItems) } : {}) }), 'utf8');
      terminal = event;
    }
    if (bytes > NATIVE_RESPONSES_OUTPUT_BYTES) throw invalidNativeOutput();
  }
  if (!terminal) throw invalidNativeOutput();
  options.signal?.throwIfAborted();
  const completion: ChatGptCompletionResponse = { text, ...(refusal ? { refusal } : {}), toolCalls, ...terminal, finishReason: terminal.finishReason ?? 'stop' };
  const response = { ...mapChatGptResponseToOpenAiResponses(request, completion), id, created_at: createdAt };
  const authoritative = [...response.output];
  reconcilePendingImages(pendingImages, authoritative);
  for (const [itemId, preview] of imagePreviews) {
    const index = authoritative.findIndex((item) => item.type === 'image_generation_call' && item.id === itemId);
    if (index < 0 || preview.publishedIndex !== undefined && preview.publishedIndex !== index) throw invalidNativeOutput();
  }
  if (identifiedMessages.size || !textOutput && imagePreviews.size || publishedSnapshots.size) {
    const messagesById = new Map([...identifiedMessages.values()].map((message) => [message.id, message]));
    for (const id of messagesById.keys()) if (!authoritative.some((item) => item.type === 'message' && item.id === id)) throw invalidNativeOutput();
    for (const [index, item] of publishedSnapshots) if (!isDeepStrictEqual(authoritative[index], item)) throw invalidNativeOutput();
    for (const [index, item] of authoritative.entries()) {
      if (publishedSnapshots.has(index)) continue;
      const live = typeof item.id === 'string' ? messagesById.get(item.id) : undefined;
      if (live) yield* finalizeIdentifiedMessage(item, index, live, terminal.outputContentIndices?.find((entry) => entry.itemId === live.id)?.indices);
      else yield* emitFinalItem(item, index);
    }
    output.push(...authoritative);
  } else {
    const consumed = new Set<number>();
    const takeMessage = () => {
      if (!textOutput) return undefined;
      const index = authoritative.findIndex((item, i) => !consumed.has(i) && item.type === 'message' && messageText(item) === text && messageRefusal(item) === refusal);
      if (index < 0) return undefined;
      consumed.add(index);
      return { ...structuredClone(authoritative[index]), id: textOutput.id };
    };
    if (textOutput) yield* finalizeIncrementalText(takeMessage());
    for (const [sourceIndex, item] of authoritative.entries()) {
      if (consumed.has(sourceIndex)) continue;
      const output_index = output.push(item) - 1;
      yield* emitFinalItem(item, output_index);
    }
  }
  if (!output.length) output.push({ id: `msg_${createMessageId()}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '', annotations: [] }] });
  response.output = output;
  if (textOutput) response.output_text = text;
  for (const index of addedIndexes) if (!doneIndexes.has(index)) throw invalidNativeOutput();
  if (Buffer.byteLength(JSON.stringify({ ...response, output: imageReferences(response.output) }), 'utf8') > NATIVE_RESPONSES_OUTPUT_BYTES) throw invalidNativeOutput();
  options.signal?.throwIfAborted();
  await options.onCompleted?.(response, completion);
  yield emit('response.completed', { response });
  yield 'data: [DONE]\n\n';
}

function mapResponsesInput(input: OpenAiResponsesRequest['input'], instructions?: string): ChatGptMessage[] {
  const messages = typeof input === 'string'
    ? [{ role: 'user' as const, content: input }]
    : input.filter((item) => item.type !== 'reasoning').map((item) => {
      const role = normalizeRole(item.role);
      return { role, content: stringifyResponsesInputItem(item) };
    });
  return typeof instructions === 'string' && instructions ? [{ role: 'system', content: instructions }, ...messages] : messages;
}

function stringifyResponsesInputItem(item: OpenAiResponsesInputItem): string {
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) return item.content.map(stringifyResponsesContentPart).join('');
  if (item.type === 'function_call') return `[function_call:${String(item.call_id ?? 'unknown')}:${String(item.name ?? 'unknown')}] ${stringifyUnknown(item.arguments)}`;
  if (item.type === 'function_call_output') return `[function_call_output:${String(item.call_id ?? 'unknown')}] ${stringifyUnknown(item.output)}`;
  if (typeof item.output === 'string') return `[output] ${item.output}`;
  return `[unsupported:${String(item.type ?? 'input_item')}] ${stringifyUnknown(item)}`;
}

function mapResponsesInputItems(input: OpenAiResponsesRequest['input'], instructions?: string): ChatGptInputItem[] {
  const inputItems: ChatGptInputItem[] = [];
  if (typeof instructions === 'string' && instructions) inputItems.push({ type: 'message', role: 'system', content: instructions });
  if (typeof input === 'string') {
    inputItems.push({ type: 'message', role: 'user', content: input });
    return inputItems;
  }
  const budget = new ResponsesReplayBudget(RESPONSES_INPUT_REPLAY_LIMITS);
  for (const item of input) {
    if (item.type === 'reasoning' || item.type === 'function_call' && typeof item.arguments === 'string') {
      try {
        const replay = parseResponsesReplayItem(item, RESPONSES_INPUT_REPLAY_LIMITS);
        if (!replay) throw new Error();
        budget.add(replay);
        inputItems.push({ type: 'replay', item: replay });
      } catch { throw new ClaudeApiError('Invalid reasoning input.', 400, 'invalid_request_error'); }
    } else if (item.type === 'function_call') {
      inputItems.push({ type: 'function_call', callId: String(item.call_id ?? 'unknown'), name: String(item.name ?? 'unknown'), arguments: item.arguments ?? {} });
    } else if (item.type === 'function_call_output') {
      inputItems.push({ type: 'function_call_output', callId: String(item.call_id ?? 'unknown'), output: mapResponsesToolOutput(item.output) });
    } else {
      const content = mapResponsesMessageContent(item);
      if (content !== undefined) inputItems.push({ type: 'message', role: normalizeRole(item.role), content });
    }
  }
  return inputItems;
}

function mapResponsesToolOutput(output: unknown): string | ChatGptInputContentPart[] {
  if (!Array.isArray(output)) return stringifyUnknown(output);
  return output.map((part) => responsesImagePart(part) ?? { type: 'text', text: stringifyResponsesContentPart(part) });
}

function stringifyResponsesContentPart(part: unknown): string {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return stringifyUnknown(part);
  const raw = part as Record<string, unknown>;
  if (raw.type === 'refusal' && typeof raw.refusal === 'string') return raw.refusal;
  if (typeof raw.text === 'string') return raw.text;
  if (raw.type === 'input_text' || raw.type === 'output_text' || raw.type === 'text') return String(raw.text ?? '');
  if (raw.type === 'input_image' || raw.type === 'image' || raw.type === 'image_url' || raw.type === 'url') return `[unsupported:${String(raw.type)}]`;
  return `[unsupported:${String(raw.type ?? 'content_part')}] ${stringifyUnknown(raw)}`;
}

function mapResponsesMessageContent(item: OpenAiResponsesInputItem): string | ChatGptInputContentPart[] | undefined {
  if (typeof item.content === 'string') return item.content || undefined;
  if (!Array.isArray(item.content)) return stringifyResponsesInputItem(item);
  const parts: ChatGptInputContentPart[] = [];
  let hasImage = false;
  for (const part of item.content) {
    const image = responsesImagePart(part);
    if (image) {
      parts.push(image);
      hasImage = true;
      continue;
    }
    appendInputText(parts, stringifyResponsesContentPart(part));
  }
  if (!parts.length) return undefined;
  return hasImage ? parts : parts.map((part) => part.type === 'text' ? part.text : '').join('');
}

function responsesImagePart(part: unknown): ChatGptInputContentPart | undefined {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined;
  const raw = part as Record<string, unknown>;
  if (raw.type !== 'input_image' && raw.type !== 'image_url') return undefined;
  const imageUrl = typeof raw.image_url === 'string'
    ? raw.image_url
    : raw.image_url && typeof raw.image_url === 'object' && !Array.isArray(raw.image_url) && typeof (raw.image_url as Record<string, unknown>).url === 'string'
      ? String((raw.image_url as Record<string, unknown>).url)
      : undefined;
  if (!imageUrl) return undefined;
  const detail = normalizeImageDetail(raw.detail);
  return { type: 'image', imageUrl, ...(detail ? { detail } : {}) };
}

function appendInputText(parts: ChatGptInputContentPart[], text: string): void {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last?.type === 'text') last.text += text;
  else parts.push({ type: 'text', text });
}

function normalizeImageDetail(value: unknown): ChatGptImageDetail | undefined {
  return value === 'auto' || value === 'low' || value === 'high' ? value : undefined;
}

function mapResponsesTools(tools: OpenAiResponsesTool[] | undefined): ChatGptTool[] | undefined {
  if (!tools) return undefined;
  const mapped: ChatGptTool[] = [];
  for (const tool of tools) {
    if (tool.type !== undefined && tool.type !== 'function') continue;
    const fn = tool.function && typeof tool.function === 'object' && !Array.isArray(tool.function) ? tool.function as Record<string, unknown> : tool;
    const name = typeof fn.name === 'string' ? fn.name : undefined;
    if (!name) continue;
    mapped.push({
      name,
      description: typeof fn.description === 'string' ? fn.description : undefined,
      inputSchema: fn.parameters && typeof fn.parameters === 'object' && !Array.isArray(fn.parameters) ? fn.parameters as Record<string, unknown> : {},
      strict: typeof fn.strict === 'boolean' ? fn.strict : undefined,
      raw: tool,
    });
  }
  return mapped;
}

function mapResponsesToolChoice(toolChoice: OpenAiResponsesToolChoice | undefined): ChatGptToolChoice | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none') return { type: 'none' };
  if (toolChoice === 'required') return { type: 'any' };
  if (toolChoice.type === 'function') {
    const name = toolChoice.function?.name ?? toolChoice.name;
    return name ? { type: 'tool', name } : undefined;
  }
  return undefined;
}

function normalizeRole(value: unknown): ChatGptMessage['role'] {
  return value === 'developer' ? 'system' : value === 'assistant' || value === 'system' ? value : 'user';
}

function normalizeResponsesStop(stop: OpenAiResponsesRequest['stop']): string[] | undefined {
  if (typeof stop === 'string') return stop ? [stop] : undefined;
  if (!Array.isArray(stop)) return undefined;
  const values = stop.filter((item) => typeof item === 'string');
  return values.length ? values : undefined;
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function messageText(item: Record<string, unknown>): string {
  return Array.isArray(item.content) ? item.content.map((part) => isPlainObject(part) && typeof part.text === 'string' ? part.text : '').join('') : '';
}

function messageRefusal(item: Record<string, unknown>): string {
  return Array.isArray(item.content) ? item.content.map((part) => isPlainObject(part) && part.type === 'refusal' && typeof part.refusal === 'string' ? part.refusal : '').join('') : '';
}

function reconcilePendingImages(pendingImages: ChatGptImageGenerationCallOutputItem[], authoritative: Array<Record<string, unknown>>): void {
  const finalImages = new Map<string, Record<string, unknown>>();
  for (const item of authoritative) {
    if (item.type !== 'image_generation_call') continue;
    if (typeof item.id !== 'string' || finalImages.has(item.id)) throw invalidNativeOutput();
    finalImages.set(item.id, item);
  }
  const pendingIds = new Set<string>();
  for (const item of pendingImages) {
    if (pendingIds.has(item.id)) throw invalidNativeOutput();
    pendingIds.add(item.id);
    const final = finalImages.get(item.id);
    if (!final || !isDeepStrictEqual(final, item)) throw invalidNativeOutput();
  }
}

function createMinimalResponse(id: string, createdAt: number, model: string, output: Array<Record<string, unknown>>, outputText: string, usage?: ChatGptUsage): OpenAiResponsesResponse {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  return { id, object: 'response', created_at: createdAt, model, status: 'completed', output, output_text: outputText, usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: usage?.totalTokens ?? inputTokens + outputTokens } };
}

function responsesSse(event: string, data: unknown): string { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }
function currentUnixSeconds(): number { return Math.floor(Date.now() / 1000); }
function createResponsesId(): string { return `resp_${createMessageId()}`; }
