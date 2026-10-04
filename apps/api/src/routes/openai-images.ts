import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ChatGptBackendError, DEFAULT_CODEX_IMAGE_MODEL, type ChatGptBackendClient, type ChatGptImageGenerationRequest, type ChatGptImageGenerationResponse } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import { readableStreamFromAsyncIterable } from '@chatgpt-to-claude/protocol-mapper';
import type { Logger } from '@chatgpt-to-claude/shared';
import type { AccountPool } from '../services/account-pool.js';
import type { AdminOperationalState } from '../services/admin-operational-state.js';
import type { RequestLog } from '../services/request-log.js';
import { createAccountRequestTracker, requestErrorOutcome, usageFromBackend } from '../services/request-statistics.js';
import { getAccessLogRequestId, getAccessLogStreamLifecycle, getAccessLogTerminal, setAccessLogMetadata } from '../middleware/access-log.js';
import { acquireRequestAccount } from './account-acquisition.js';
import { imageAccountAcquireOptions } from './image-account-eligibility.js';
import { mapChatGptBackendError, mapRequestCancellation, parseRequestJson, unexpectedApiError } from './backend-errors.js';
import { boundedClose } from './prepare-stream.js';
import { logHttpRequestFailure, releaseAccountWhenDone } from './stream-lifecycle.js';

const ROUTE = '/v1/images/generations';
const MAX_PROMPT_LENGTH = 32_000;
interface ImageRequest extends ChatGptImageGenerationRequest { model: string; stream: boolean; }
export interface OpenAiImagesRouteDeps {
  backend: ChatGptBackendClient;
  accountPool: AccountPool;
  requestLog: RequestLog;
  operationalState?: AdminOperationalState;
  backendProvider?: 'mock' | 'session';
  accountAcquireTimeoutMs?: number;
  sseKeepaliveIntervalMs?: number;
  logger?: Logger;
}

export function createOpenAiImagesRoute(deps: OpenAiImagesRouteDeps): Hono {
  const app = new Hono();
  app.use(ROUTE, bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json(openAiError(new ClaudeApiError('Image request body exceeds 128 KiB.', 413, 'invalid_request_error')), 413) }));
  app.post(ROUTE, async (c) => {
    try {
      const request = parseImageRequest(await parseRequestJson(() => c.req.json()));
      setAccessLogMetadata(c, { model: request.model, backendModel: request.model, stream: request.stream });
      if (!deps.backend.generateImages) throw new ClaudeApiError('Image generation is not supported by this backend.', 501, 'api_error');
      // Image models have their own endpoint and must not depend on the text catalog.
      const account = await acquireRequestAccount(c, deps.accountPool, imageAccountAcquireOptions(deps.backendProvider), deps.accountAcquireTimeoutMs);
      const tracker = createAccountRequestTracker(deps.operationalState, account);
      const cancellation = new AbortController();
      const signal = AbortSignal.any([c.req.raw.signal, cancellation.signal]);
      let failure: unknown;
      let streamOwner: ReturnType<typeof releaseAccountWhenDone> | undefined;
      let responseBody: ReadableStream<Uint8Array> | undefined;
      let streamOwnsLease = false;
      try {
        const { stream: _stream, ...backendRequest } = request;
        deps.requestLog.record({ route: ROUTE, model: request.model, stream: request.stream });
        const result = await cancellableImageRequest(() => deps.backend.generateImages!(backendRequest, { account, signal }), signal);
        const response = imageResponse(result, request);
        if (request.stream) {
          if (response.data.length !== 1) throw new ChatGptBackendError('Invalid image result count.', 'invalid_response');
          tracker.observeUsage?.(usageFromBackend(result.usage));
          const event = { type: 'image_generation.completed', b64_json: response.data[0].b64_json,
            created_at: response.created, output_format: response.output_format,
            ...(response.background === undefined ? {} : { background: response.background }),
            ...(response.quality === undefined ? {} : { quality: response.quality }),
            ...(response.size === undefined ? {} : { size: response.size }),
            ...(response.usage === undefined ? {} : { usage: response.usage }),
          };
          // The private endpoint returns a complete JSON result, never preview frames.
          const events = streamOwner = releaseAccountWhenDone(deps.accountPool, account, completedImageEvent(event), imageStreamError, tracker, c.req.raw.signal,
            { route: ROUTE, requestId: getAccessLogRequestId(c), logger: deps.logger, terminal: getAccessLogTerminal(c), lifecycle: getAccessLogStreamLifecycle(c) },
            async () => { cancellation.abort(); });
          responseBody = readableStreamFromAsyncIterable(events, { signal: c.req.raw.signal, gracefulAbort: true, sseKeepaliveIntervalMs: deps.sseKeepaliveIntervalMs, onCancel: () => events.cancel() });
          const streamed = new Response(responseBody, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' } });
          streamOwnsLease = true;
          return streamed;
        }
        const json = c.json(response);
        tracker.finish('success', usageFromBackend(result.usage));
        return json;
      } catch (error) {
        streamOwner?.abandon();
        failure = error;
        tracker.finish(requestErrorOutcome(error, c.req.raw.signal));
        if (responseBody) await boundedClose(() => responseBody!.cancel());
        throw error;
      } finally {
        if (!streamOwnsLease) {
          cancellation.abort();
          deps.accountPool.release(account, imageAccountReleaseError(failure));
        }
      }
    } catch (error) {
      logHttpRequestFailure(error, { route: ROUTE, requestId: getAccessLogRequestId(c), logger: deps.logger, terminal: getAccessLogTerminal(c) }, c.req.raw.signal);
      const apiError = mapRequestCancellation(error, c.req.raw.signal) ?? (error instanceof ClaudeApiError ? error
        : error instanceof ChatGptBackendError && error.status === 403 ? new ClaudeApiError('Image generation is not permitted for this account.', 403, 'permission_error')
          : mapChatGptBackendError(error) ?? unexpectedApiError());
      return c.json(openAiError(apiError), apiError.status as 400);
    }
  });
  return app;
}

function parseImageRequest(value: unknown): ImageRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClaudeApiError('Request body must be a JSON object.');
  const raw = value as Record<string, unknown>;
  const allowed = new Set(['model', 'prompt', 'background', 'n', 'quality', 'size', 'response_format', 'output_format', 'stream', 'partial_images']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new ClaudeApiError('Unsupported image generation parameter.');
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > MAX_PROMPT_LENGTH) throw new ClaudeApiError('prompt must be a nonempty string of at most 32000 characters.');
  const model = raw.model === undefined ? DEFAULT_CODEX_IMAGE_MODEL : raw.model;
  if (typeof model !== 'string' || model.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(model)) throw new ClaudeApiError('model must be a valid model identifier.');
  if (raw.n !== undefined && (typeof raw.n !== 'number' || !Number.isInteger(raw.n) || raw.n < 1 || raw.n > 10)) throw new ClaudeApiError('n must be an integer between 1 and 10.');
  if (raw.stream !== undefined && typeof raw.stream !== 'boolean') throw new ClaudeApiError('stream must be a boolean.');
  if (raw.stream === true && typeof raw.n === 'number' && raw.n !== 1) throw new ClaudeApiError('Streaming image generation supports n=1 only.');
  if (raw.partial_images !== undefined && raw.partial_images !== 0) throw new ClaudeApiError('This image backend does not support partial previews; partial_images must be 0 or omitted.');
  if (raw.response_format !== undefined && raw.response_format !== 'b64_json') throw new ClaudeApiError('Only response_format=b64_json is supported.');
  if (raw.output_format !== undefined && raw.output_format !== 'png') throw new ClaudeApiError('Only output_format=png is supported.');
  if (raw.background !== undefined && !['transparent', 'opaque', 'auto'].includes(raw.background as string)) throw new ClaudeApiError('background must be transparent, opaque, or auto.');
  if (raw.quality !== undefined && !['low', 'medium', 'high', 'auto'].includes(raw.quality as string)) throw new ClaudeApiError('quality must be low, medium, high, or auto.');
  if (raw.size !== undefined && (typeof raw.size !== 'string' || (raw.size !== 'auto' && !/^[1-9]\d{0,4}x[1-9]\d{0,4}$/.test(raw.size)))) throw new ClaudeApiError('size must be auto or a widthxheight value.');
  return { model, prompt: raw.prompt, stream: raw.stream === true,
    ...(raw.n === undefined ? {} : { n: raw.n as number }),
    ...(raw.background === undefined ? {} : { background: raw.background as ChatGptImageGenerationRequest['background'] }),
    ...(raw.quality === undefined ? {} : { quality: raw.quality as ChatGptImageGenerationRequest['quality'] }),
    ...(raw.size === undefined ? {} : { size: raw.size as string }),
  };
}

function imageResponse(result: ChatGptImageGenerationResponse, request: ImageRequest) {
  if (!Number.isSafeInteger(result.created) || result.created < 0 || !Array.isArray(result.data) || !result.data.length || result.data.length > 10
    || result.data.some((item) => typeof item.b64_json !== 'string' || !item.b64_json)
    || (result.output_format !== undefined && result.output_format !== 'png')) throw new ChatGptBackendError('Invalid image generation response.', 'invalid_response');
  const usage: Record<string, number> = {};
  for (const [wire, internal] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'], ['total_tokens', 'totalTokens']] as const) {
    const count = result.usage?.[internal];
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) usage[wire] = count;
  }
  const background = result.background ?? request.background;
  const quality = result.quality ?? request.quality;
  const size = result.size ?? request.size;
  return { created: result.created,
    data: result.data.map((item) => ({ b64_json: item.b64_json, ...(item.generation_id === undefined ? {} : { generation_id: item.generation_id }) })),
    output_format: 'png' as const,
    ...(background === undefined ? {} : { background }), ...(quality === undefined ? {} : { quality }), ...(size === undefined ? {} : { size }),
    ...(Object.keys(usage).length ? { usage } : {}),
  };
}

function imageAccountReleaseError(error: unknown): ChatGptBackendError | undefined {
  if (!(error instanceof ChatGptBackendError)) return undefined;
  if (error.status === 403 || (error.code === 'rate_limited' && error.safeDiagnostic?.rateLimitScope === 'image_gen')) return undefined;
  return error;
}

async function cancellableImageRequest<T>(request: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const cancelled = () => new DOMException('Request cancelled.', 'AbortError');
  if (signal.aborted) throw cancelled();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(cancelled()); signal.addEventListener('abort', onAbort, { once: true }); });
  try {
    const result = await Promise.race([request(), aborted]);
    if (signal.aborted) throw cancelled();
    return result;
  }
  finally { signal.removeEventListener('abort', onAbort); }
}

function openAiError(error: ClaudeApiError) { return { error: { message: error.message, type: error.type, code: null } }; }
async function* completedImageEvent(event: object): AsyncIterable<string> { yield 'event: image_generation.completed\ndata: ' + JSON.stringify(event) + '\n\n'; }
async function* imageStreamError(): AsyncIterable<string> { yield 'event: error\ndata: ' + JSON.stringify(openAiError(unexpectedApiError())) + '\n\n'; }
