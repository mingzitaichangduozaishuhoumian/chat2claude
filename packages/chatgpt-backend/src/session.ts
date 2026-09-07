import { CODEX_ORIGINATOR, codexUserAgent, normalizeCodexClientVersion } from './codex-protocol.js';
import type { ChatGptModelDiscoveryDiagnostic, ChatGptModelDiscoveryResult, ChatGptReplayItem } from './client.js';
import type { ChatGptAccountQuota, ChatGptAdditionalQuotaLimit, ChatGptBackendClient, ChatGptBackendHealthCheckResult, ChatGptBackendRequestContext, ChatGptCompletionRequest, ChatGptCompletionResponse, ChatGptDiscoveredModel, ChatGptFinishReason, ChatGptInputContentPart, ChatGptInputItem, ChatGptModelControlCapabilities, ChatGptQuotaWindow, ChatGptReasoningLevelOption, ChatGptServiceTierOption, ChatGptSessionSecret, ChatGptToolCall, ChatGptUsage } from './client.js';
import type { ChatGptStreamEvent } from './events.js';
import { ChatGptBackendError, sanitizeBackendDiagnostic, type ChatGptBackendErrorCode } from './errors.js';
import { ResponsesToolCalls } from './responses-tools.js';
import { parseResponsesReplayItem, ResponsesReplay, ResponsesReplayBudget } from './responses-replay.js';

export interface SessionChatGptBackendOptions {
  baseUrl: string;
  /** @deprecated Legacy absolute generation and short-operation timeout. New fields take precedence. */
  timeoutMs?: number;
  requestTimeoutMs?: number;
  responseHeaderTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  streamTotalTimeoutMs?: number;
  clientVersion?: string;
  /** @deprecated The Codex protocol always uses codex_cli_rs. */
  originator?: string;
  fetch?: typeof fetch;
}

type JsonObject = Record<string, unknown>;

export class SessionChatGptBackend implements ChatGptBackendClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly streamTimeouts: { headers: number; idle: number; total: number };
  private readonly clientVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SessionChatGptBackendOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.requestTimeoutMs ?? options.timeoutMs ?? 60_000;
    const legacy = options.requestTimeoutMs === undefined && options.responseHeaderTimeoutMs === undefined && options.streamIdleTimeoutMs === undefined && options.streamTotalTimeoutMs === undefined;
    this.streamTimeouts = {
      headers: options.responseHeaderTimeoutMs ?? (legacy ? options.timeoutMs ?? 60_000 : 60_000),
      idle: options.streamIdleTimeoutMs ?? (legacy ? options.timeoutMs ?? 300_000 : 300_000),
      total: options.streamTotalTimeoutMs ?? (legacy ? options.timeoutMs ?? 0 : 0),
    };
    this.clientVersion = normalizeCodexClientVersion(options.clientVersion);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listModels(context?: ChatGptBackendRequestContext): Promise<ChatGptDiscoveredModel[]> {
    return (await this.discoverModels(context)).models;
  }

  async discoverModels(context?: ChatGptBackendRequestContext): Promise<ChatGptModelDiscoveryResult> {
    if (!context?.account) return { models: [], status: 'unknown' };
    const secret = requireSessionSecret(context);
    return this.runWithTimeout(async (signal, cancelBody) => {
      const response = await this.fetchResponse(
        this.backendApiEndpoint('/codex/models', { client_version: this.clientVersion }),
        { method: 'GET', headers: this.headers(secret, false, 'application/json') },
        signal,
      );
      const diagnostic = discoveryDiagnostic(response, this.clientVersion);
      if (!response.ok) {
        await cancelBody(response);
        signal.throwIfAborted();
        throw new ChatGptBackendError(`ChatGPT models discovery failed: HTTP ${response.status}`, backendErrorCodeForStatus(response.status), {
          status: response.status, discoveryDiagnostic: diagnostic,
        });
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (signal.aborted) throw error;
        diagnostic.reasons.push('invalid_json');
        throw invalidDiscoveryResponse(diagnostic);
      }
      return parseDiscoveredModels(payload, diagnostic);
    }, context.signal);
  }

  async healthCheck(context?: ChatGptBackendRequestContext): Promise<ChatGptBackendHealthCheckResult> {
    try {
      await this.listModels(context);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async getAccountQuota(context?: ChatGptBackendRequestContext): Promise<ChatGptAccountQuota> {
    const secret = requireSessionSecret(context);
    const { response, payload } = await this.fetchJsonWithTimeout(
      this.backendApiEndpoint('/wham/usage'),
      { method: 'GET', headers: this.headers(secret, false, 'application/json') },
      context?.signal,
      'ChatGPT quota response was not valid JSON.',
    );
    if (!response.ok) throw httpBackendError('ChatGPT quota request failed', response.status);
    const quota = normalizeAccountQuota(payload);
    // The dedicated endpoint is authoritative; never substitute an embedded or inferred balance.
    try {
      const headers = this.headers(secret, false, 'application/json');
      headers.set('OpenAI-Beta', 'codex-1');
      headers.set('Originator', 'Codex Desktop');
      const credits = await this.fetchJsonWithTimeout(
        this.backendApiEndpoint('/wham/rate-limit-reset-credits'),
        { method: 'GET', headers }, context?.signal, 'Invalid reset credit response.',
      );
      quota.resetCredits = credits.response.ok ? normalizeResetCredits(credits.payload) : { error: 'fetch_failed' };
    } catch {
      context?.signal?.throwIfAborted();
      quota.resetCredits = { error: 'fetch_failed' };
    }
    return quota;
  }

  async consumeAccountResetCredit(redeemRequestId: string, context?: ChatGptBackendRequestContext): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(redeemRequestId)) {
      throw new ChatGptBackendError('Invalid reset request.', 'invalid_request');
    }
    const secret = requireSessionSecret(context);
    await this.runWithTimeout(async (signal, cancelBody) => {
      const response = await this.fetchResponse(this.backendApiEndpoint('/wham/rate-limit-reset-credits/consume'), {
        method: 'POST', headers: this.headers(secret, true, 'application/json'),
        body: JSON.stringify({ redeem_request_id: redeemRequestId }),
      }, signal);
      // No provider body, including a successful redemption payload, leaves this adapter.
      await cancelBody(response);
      signal.throwIfAborted();
      if (!response.ok) throw httpBackendError('Reset credit request failed', response.status);
    }, context?.signal);
  }

  async complete(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): Promise<ChatGptCompletionResponse> {
    let text = '';
    let finishReason: ChatGptFinishReason = 'stop';
    let usage: ChatGptUsage | undefined;
    let replayItems: ChatGptReplayItem[] | undefined;
    let replayEligible: boolean | undefined;
    let outputItems: ChatGptCompletionResponse['outputItems'];
    let terminalSuccessful: boolean | undefined;
    const toolCalls: ChatGptToolCall[] = [];
    for await (const event of this.stream(request, context)) {
      if (event.type === 'text_delta') text += event.text;
      if (event.type === 'tool_call') toolCalls.push(event.toolCall);
      if (event.type === 'done') {
        if (event.finishReason) finishReason = event.finishReason;
        if (event.usage) usage = event.usage;
        if (event.replayItems) { replayItems = event.replayItems; replayEligible = event.replayEligible; }
        if (event.outputItems) outputItems = event.outputItems;
        terminalSuccessful = event.terminalSuccessful;
      }
    }
    return { text, finishReason, ...(toolCalls.length ? { toolCalls } : {}), ...(usage ? { usage } : {}), ...(replayItems ? { replayItems, replayEligible } : {}), ...(outputItems ? { outputItems } : {}), ...(terminalSuccessful === false ? { terminalSuccessful } : {}) };
  }

  async *stream(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): AsyncIterable<ChatGptStreamEvent> {
    validateSessionRequest(request);
    const secret = requireSessionSecret(context);
    const body = buildResponsesBody(request);
    const serialized = JSON.stringify(body);
    const replayItemCount = request.inputItems?.filter(item => item.type === 'replay').length ?? 0;
    const tools = Array.isArray(body.tools) ? body.tools : [];
    context?.onWireMetrics?.({
      upstreamBodyBytes: Buffer.byteLength(serialized, 'utf8'),
      upstreamInputItemCount: Array.isArray(body.input) ? body.input.length : 0,
      replayItemCount, replayApplied: replayItemCount > 0,
      toolCount: tools.length,
      toolSchemaBytes: tools.reduce((sum: number, tool: unknown) => sum + (isPlainObject(tool) && tool.parameters !== undefined ? Buffer.byteLength(JSON.stringify(tool.parameters), 'utf8') : 0), 0),
    });
    const lifetime = createRequestLifetime(this.streamTimeouts.total, context?.signal, this.streamTimeouts);
    let httpStatus: number | undefined;
    try {
      const response = await lifetime.run(() => this.fetchResponse(this.backendApiEndpoint('/codex/responses'), {
        method: 'POST',
        headers: this.headers(secret, true),
        body: serialized,
      }, lifetime.signal));
      lifetime.headersReceived();
      if (!response.ok) {
        const diagnostic = await readHttpErrorDiagnostic(response, lifetime);
        if (context?.signal?.aborted) throw abortError();
        throw new ChatGptBackendError(`ChatGPT responses request failed: HTTP ${response.status}`, backendErrorCodeForStatus(response.status), {
          status: response.status, safeDiagnostic: { ...diagnostic, httpStatus: response.status, failurePhase: 'response_headers' },
        });
      }

      httpStatus = response.status;
      let latestUsage: ChatGptUsage | undefined;
      let sawToolCall = false;
      const tools = new ResponsesToolCalls(httpStatus);
      const replay = new ResponsesReplay();
      for await (const frame of iterateSseData(response, lifetime)) {
        const parsed = parseJson(frame.data);
        const type = parsed?.type ?? frame.event;
        const terminalError = responseEventError(frame.event, parsed, httpStatus);
        if (terminalError) throw terminalError;
        if (frame.data === '[DONE]') break;
        if (!parsed) continue;
        const replayResult = replay.accept(type, parsed);
        latestUsage = mergeUsage(latestUsage, extractUsage(parsed));
        for (const toolCall of tools.accept(type, parsed)) {
          sawToolCall = true;
          yield { type: 'tool_call', toolCall };
        }
        // Standard Responses events are typed. Only text deltas may reach the text mapper.
        if (typeof type !== 'string' || !type.startsWith('response.') || type === 'response.output_text.delta') {
          const delta = extractTextDelta(parsed);
          if (delta) yield { type: 'text_delta', text: delta };
          const toolCall = extractToolCall(parsed);
          if (toolCall) {
            for (const call of tools.compatibility(toolCall)) {
              sawToolCall = true;
              yield { type: 'tool_call', toolCall: call };
            }
          }
        }
        if (isDoneEvent({ ...parsed, type })) {
          for (const toolCall of tools.finish()) {
            sawToolCall = true;
            yield { type: 'tool_call', toolCall };
          }
          lifetime.signal.throwIfAborted();
          yield { type: 'done', finishReason: extractFinishReason(parsed) ?? (sawToolCall ? 'tool_calls' : 'stop'), ...(latestUsage ? { usage: latestUsage } : {}), ...replayResult };
          return;
        }
      }
      for (const toolCall of tools.finish()) {
        sawToolCall = true;
        yield { type: 'tool_call', toolCall };
      }
      yield { type: 'done', terminalSuccessful: false, finishReason: sawToolCall ? 'tool_calls' : 'stop', ...(latestUsage ? { usage: latestUsage } : {}) };
    } catch (error) {
      // Diagnostic reads are best-effort: timeout/read/cleanup failures cannot replace
      // an already received HTTP failure. An actual caller cancellation still wins.
      if (!context?.signal?.aborted && error instanceof ChatGptBackendError && error.safeDiagnostic?.failurePhase === 'response_headers') throw error;
      if (context?.signal?.aborted) throw abortError();
      lifetime.signal.throwIfAborted();
      if (error instanceof ChatGptBackendError) throw error;
      if (error instanceof Error && error.name === 'AbortError') throw abortError();
      if (httpStatus !== undefined) {
        throw new ChatGptBackendError('ChatGPT session backend response body could not be read.', error instanceof SyntaxError ? 'invalid_response' : 'network_error', {
          status: 502, safeDiagnostic: { httpStatus, failurePhase: 'response_body_read' },
        });
      }
      throw error;
    } finally {
      lifetime.dispose();
    }
  }

  private headers(secret: ChatGptSessionSecret, includeContentType: boolean, accept = 'text/event-stream'): Headers {
    const headers = new Headers();
    headers.set('authorization', `Bearer ${secret.accessToken}`);
    headers.set('accept', accept);
    if (includeContentType) headers.set('content-type', 'application/json');
    if (secret.cookie) headers.set('cookie', secret.cookie);
    headers.set('user-agent', codexUserAgent(this.clientVersion, secret.userAgent));
    if (secret.deviceId) headers.set('oai-device-id', secret.deviceId);
    if (secret.accountId) headers.set('chatgpt-account-id', secret.accountId);
    headers.set('originator', CODEX_ORIGINATOR);
    return headers;
  }

  private backendApiEndpoint(path: string, query?: Record<string, string>): string {
    const backendApiBase = this.baseUrl.endsWith('/backend-api') ? this.baseUrl : `${this.baseUrl}/backend-api`;
    const url = new URL(`${backendApiBase}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    return url.toString();
  }

  private async runWithTimeout<T>(operation: (signal: AbortSignal, cancelBody: (response: Response) => Promise<void>) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
    const lifetime = createRequestLifetime(this.timeoutMs, callerSignal);
    let cancellation: Promise<void> | undefined;
    const cancelBody = (response: Response) => cancellation ??= cancelResponseBody(response);
    try {
      return await lifetime.run(() => operation(lifetime.signal, cancelBody));
    } finally {
      lifetime.dispose();
      // An abort/timeout may win the race while non-OK body cleanup is still pending.
      await cancellation;
    }
  }

  private async fetchResponse(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof Error && error.name === 'AbortError') throw abortError();
      throw new ChatGptBackendError('ChatGPT session backend network request failed.', 'network_error', { safeDiagnostic: { failurePhase: 'request_fetch' } });
    }
  }

  private fetchJsonWithTimeout(url: string, init: RequestInit, callerSignal: AbortSignal | undefined, invalidResponseMessage: string): Promise<{ response: Response; payload?: unknown }> {
    return this.runWithTimeout(async (signal, cancelBody) => {
      const response = await this.fetchResponse(url, init, signal);
      if (!response.ok) {
        await cancelBody(response);
        signal.throwIfAborted();
        return { response };
      }
      try {
        return { response, payload: await response.json() };
      } catch (error) {
        if (signal.aborted) throw error;
        throw new ChatGptBackendError(invalidResponseMessage, 'invalid_response', { status: 502, safeDiagnostic: { httpStatus: response.status, failurePhase: 'response_body_read' } });
      }
    }, callerSignal);
  }
}

function createRequestLifetime(timeoutMs: number, callerSignal?: AbortSignal, stream?: { headers: number; idle: number; total: number }) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let phaseTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const dispose = () => {
    disposed = true;
    clearTimeout(timer);
    clearTimeout(phaseTimer);
    callerSignal?.removeEventListener('abort', cancel);
  };
  const cancel = () => {
    controller.abort(abortError());
    dispose();
  };
  const expire = (timeoutKind?: 'response_headers' | 'stream_idle' | 'stream_total') => {
    controller.abort(callerSignal?.aborted ? abortError() : new ChatGptBackendError('ChatGPT session backend request timed out.', 'timeout', {
      status: 504, ...(timeoutKind ? { safeDiagnostic: { timeoutKind } } : {}),
    }));
    dispose();
  };
  const activity = () => {
    if (!stream || disposed) return;
    clearTimeout(phaseTimer);
    phaseTimer = setTimeout(() => expire('stream_idle'), stream.idle);
  };
  if (timeoutMs > 0) timer = setTimeout(() => expire(stream ? 'stream_total' : undefined), timeoutMs);
  if (stream) phaseTimer = setTimeout(() => expire('response_headers'), stream.headers);
  callerSignal?.addEventListener('abort', cancel, { once: true });
  if (callerSignal?.aborted) cancel();
  return {
    signal: controller.signal,
    dispose,
    headersReceived: activity,
    activity,
    async run<T>(operation: () => Promise<T>): Promise<T> {
      controller.signal.throwIfAborted();
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const result = await Promise.race([operation(), aborted]);
        controller.signal.throwIfAborted();
        return result;
      } catch (error) {
        controller.signal.throwIfAborted();
        throw error;
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

function normalizeAccountQuota(value: unknown): ChatGptAccountQuota {
  if (!isPlainObject(value) || !isPlainObject(value.rate_limit)) {
    throw new ChatGptBackendError('ChatGPT quota response was invalid.', 'invalid_response');
  }
  const raw = value;
  const rateLimit = isPlainObject(raw.rate_limit) ? raw.rate_limit : {};
  const quota: ChatGptAccountQuota = {
    ...optionalString('providerAccountId', raw.account_id),
    ...optionalString('providerUserId', raw.user_id),
    ...optionalString('planType', raw.plan_type),
    ...optionalBoolean('allowed', rateLimit.allowed),
    ...optionalBoolean('limitReached', rateLimit.limit_reached),
    ...optionalString('rateLimitReachedType', rateLimitReachedType(raw.rate_limit_reached_type)),
    windows: normalizeQuotaWindows(rateLimit),
  };

  const additionalLimits = normalizeAdditionalQuotaLimits(raw.additional_rate_limits);
  if (additionalLimits.length) quota.additionalLimits = additionalLimits;
  return quota;
}

function normalizeResetCredits(value: unknown): NonNullable<ChatGptAccountQuota['resetCredits']> {
  if (!isPlainObject(value)) return { error: 'invalid_response' };
  const countValue = value.available_count ?? value.availableCount;
  const count = typeof countValue === 'string' && countValue.trim() ? Number(countValue) : countValue;
  const availableCount = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
  const credits: NonNullable<NonNullable<ChatGptAccountQuota['resetCredits']>['credits']> = [];
  if (Array.isArray(value.credits)) for (const item of value.credits) {
    if (!isPlainObject(item) || (item.reset_type ?? item.resetType) !== 'codex_rate_limits' || item.status !== 'available') continue;
    const expiresAt = resetCreditTimestamp(item.expires_at ?? item.expiresAt);
    if (!expiresAt) continue;
    const grantedAt = resetCreditTimestamp(item.granted_at ?? item.grantedAt);
    // Normalize IDs only inside the adapter; the Admin service strips them before caching/presentation.
    const id = typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item.id.trim()) ? item.id.trim() : undefined;
    credits.push({ ...(id ? { id } : {}), status: 'available', expiresAt, ...(grantedAt ? { grantedAt } : {}) });
  }
  return {
    ...(availableCount === undefined ? { error: 'invalid_response' as const } : { availableCount }),
    ...(Array.isArray(value.credits) ? { credits } : {}),
  };
}

function resetCreditTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function normalizeAdditionalQuotaLimits(value: unknown): ChatGptAdditionalQuotaLimit[] {
  if (!Array.isArray(value)) return [];
  const limits: ChatGptAdditionalQuotaLimit[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const rateLimit = isPlainObject(item.rate_limit) ? item.rate_limit : {};
    limits.push({
      ...optionalString('meteredFeature', item.metered_feature),
      ...optionalString('limitName', item.limit_name),
      ...optionalBoolean('allowed', rateLimit.allowed),
      ...optionalBoolean('limitReached', rateLimit.limit_reached),
      ...optionalString('rateLimitReachedType', rateLimitReachedType(item.rate_limit_reached_type)),
      windows: normalizeQuotaWindows(rateLimit),
    });
  }
  return limits;
}

function normalizeQuotaWindows(rateLimit: JsonObject): ChatGptQuotaWindow[] {
  const windows: ChatGptQuotaWindow[] = [];
  for (const [position, value] of [
    ['primary', rateLimit.primary_window],
    ['secondary', rateLimit.secondary_window],
  ] as const) {
    if (!isPlainObject(value)) continue;
    const durationSeconds = positiveNumber(value.limit_window_seconds);
    const window: ChatGptQuotaWindow = {
      position,
      descriptor: quotaWindowDescriptor(position, durationSeconds),
      ...optionalNumber('usedPercent', percentage(value.used_percent)),
      ...optionalNumber('durationSeconds', durationSeconds),
      ...optionalNumber('resetAfterSeconds', nonNegativeNumber(value.reset_after_seconds)),
    };
    const resetAt = unixSecondsToIso(value.reset_at);
    if (resetAt !== undefined) window.resetAt = resetAt;
    windows.push(window);
  }
  return windows;
}

function quotaWindowDescriptor(position: ChatGptQuotaWindow['position'], durationSeconds: number | undefined): string {
  if (durationSeconds === 18_000) return 'five-hour';
  if (durationSeconds === 604_800) return 'weekly';
  return durationSeconds === undefined ? position : `${position}-${durationSeconds}-seconds`;
}

function rateLimitReachedType(value: unknown): unknown {
  return isPlainObject(value) ? value.type : undefined;
}

function optionalString<Key extends string>(key: Key, value: unknown): Partial<Record<Key, string>> {
  return typeof value === 'string' && value.length > 0 ? { [key]: value } as Record<Key, string> : {};
}

function optionalBoolean<Key extends string>(key: Key, value: unknown): Partial<Record<Key, boolean>> {
  return typeof value === 'boolean' ? { [key]: value } as Record<Key, boolean> : {};
}

function optionalNumber<Key extends string>(key: Key, value: number | undefined): Partial<Record<Key, number>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, number>;
}

function percentage(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function unixSecondsToIso(value: unknown): string | undefined {
  const seconds = nonNegativeNumber(value);
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function validateSessionRequest(request: ChatGptCompletionRequest): void {
  if (request.reasoningEffort?.trim().toLowerCase() === 'ultra') {
    throw new ChatGptBackendError(
      'The local-only reasoning effort "ultra" must be resolved to a target-supported upstream effort before calling the ChatGPT session backend.',
      'invalid_request',
      { status: 400 },
    );
  }
}

function httpBackendError(prefix: string, status: number): ChatGptBackendError {
  return new ChatGptBackendError(`${prefix}: HTTP ${status}`, backendErrorCodeForStatus(status), { status, safeDiagnostic: { httpStatus: status, failurePhase: 'response_headers' } });
}

function backendErrorCodeForStatus(status: number): ChatGptBackendErrorCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  return 'upstream_error';
}

function abortError(): Error {
  const error = new Error('ChatGPT session backend request was cancelled.');
  error.name = 'AbortError';
  return error;
}

/** Codex OAuth private endpoint allowlist, deliberately not the public Responses API.
 * Token limits, sampling, stop, truncation, cache controls and context_management
 * stay in the IR but must never be serialized here (including via backendOptions).
 */
function buildResponsesBody(request: ChatGptCompletionRequest): JsonObject {
  const replayBudget = new ResponsesReplayBudget();
  const body: JsonObject = {
    model: request.model,
    input: request.inputItems?.length ? request.inputItems.map((item) => toResponsesInputItem(item, replayBudget)) : request.messages.map((message) => toResponsesInputItem({ type: 'message', ...message })),
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    instructions: '',
  };
  applyResponsesBodyOptions(body, request.backendOptions?.responsesBody);
  if (request.reasoningEffort) body.reasoning = { effort: request.reasoningEffort };
  // Discovery can advertise other tiers; only canonical priority is proven compatible.
  if (request.serviceTier === 'priority') body.service_tier = 'priority';
  const mappedTools = request.tools?.length ? request.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: tool.strict ?? false })) : [];
  const rawTools = Array.isArray(body.tools) ? body.tools : [];
  if (mappedTools.length || rawTools.length) {
    body.tools = [...mappedTools, ...rawTools].map((tool) => isPlainObject(tool) && tool.type === 'function' ? { ...tool, strict: tool.strict ?? false } : tool);
    body.parallel_tool_calls = request.parallelToolCalls ?? body.parallel_tool_calls ?? true;
  } else {
    delete body.parallel_tool_calls;
  }
  if (request.toolChoice) body.tool_choice = request.toolChoice.type === 'tool' ? { type: 'function', name: request.toolChoice.name } : request.toolChoice.type === 'any' ? 'required' : request.toolChoice.type;
  return body;
}

function applyResponsesBodyOptions(body: JsonObject, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const raw = value as JsonObject;
  if (typeof raw.previous_response_id === 'string' || raw.previous_response_id === null) body.previous_response_id = raw.previous_response_id;
  if (raw.metadata === null || raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)) body.metadata = raw.metadata;
  if (typeof raw.parallel_tool_calls === 'boolean') body.parallel_tool_calls = raw.parallel_tool_calls;
  if (raw.text && typeof raw.text === 'object' && !Array.isArray(raw.text)) body.text = raw.text;
  if (Array.isArray(raw.tools)) body.tools = raw.tools.map((tool) => isPlainObject(tool) ? { ...tool } : tool);
  if (body.tool_choice === undefined && isPlainObject(raw.tool_choice)) body.tool_choice = { ...raw.tool_choice };
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toResponsesInputItem(item: ChatGptInputItem, replayBudget?: ResponsesReplayBudget): JsonObject {
  if (item.type === 'replay') {
    const replay = parseResponsesReplayItem(item.item);
    if (!replay) throw new ChatGptBackendError('ChatGPT session backend replay input was invalid.', 'invalid_request', { status: 400 });
    replayBudget?.add(replay);
    return { ...replay };
  }
  if (item.type === 'message') return { type: 'message', role: item.role === 'system' ? 'developer' : item.role, content: toResponsesContent(item.content, item.role) };
  if (item.type === 'function_call') return { type: 'function_call', call_id: item.callId, name: item.name, arguments: stringifyArguments(item.arguments) };
  return { type: 'function_call_output', call_id: item.callId, output: item.output };
}

function toResponsesContent(content: string | ChatGptInputContentPart[], role: 'system' | 'user' | 'assistant'): string | JsonObject[] {
  if (typeof content === 'string') return content;
  return content.map((part) => part.type === 'text'
    ? { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text }
    : { type: 'input_image', image_url: part.imageUrl, ...(part.detail ? { detail: part.detail } : {}) });
}

function stringifyArguments(value: unknown): string {
  if (typeof value === 'string') return value || '{}';
  try { return JSON.stringify(value ?? {}); } catch { return String(value); }
}

function discoveryDiagnostic(response: Response, clientVersion: string): ChatGptModelDiscoveryDiagnostic {
  const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const contentType = !mime ? 'missing' : mime === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mime)
    ? 'json' : mime === 'text/event-stream' ? 'event_stream' : mime === 'text/html' ? 'html' : 'other';
  return { clientVersion, httpStatus: response.status, contentType, envelope: 'unknown', candidateCount: 0, acceptedCount: 0, rejectedCount: 0, duplicateCount: 0, reasons: [] };
}

function invalidDiscoveryResponse(diagnostic: ChatGptModelDiscoveryDiagnostic): ChatGptBackendError {
  return new ChatGptBackendError('ChatGPT models response was incompatible with the model discovery protocol.', 'invalid_response', {
    status: 502, discoveryDiagnostic: diagnostic,
  });
}

function parseDiscoveredModels(value: unknown, diagnostic: ChatGptModelDiscoveryDiagnostic): ChatGptModelDiscoveryResult {
  const rawModels = readModelArray(value, diagnostic);
  if (!Array.isArray(rawModels)) {
    diagnostic.reasons.push(diagnostic.envelope === 'unknown' ? 'unknown_envelope' : 'invalid_model_array');
    throw invalidDiscoveryResponse(diagnostic);
  }
  diagnostic.candidateCount = rawModels.length;
  const ids = new Set<string>();
  const models: ChatGptDiscoveredModel[] = [];
  for (const item of rawModels) {
    const model = normalizeDiscoveredModel(item);
    if (!model) { diagnostic.rejectedCount += 1; continue; }
    if (ids.has(model.id)) { diagnostic.duplicateCount += 1; continue; }
    ids.add(model.id);
    models.push(model);
  }
  diagnostic.acceptedCount = models.length;
  if (diagnostic.rejectedCount) diagnostic.reasons.push('invalid_model_id');
  if (diagnostic.duplicateCount) diagnostic.reasons.push('duplicate_model_id');
  if (rawModels.length && !models.length) throw invalidDiscoveryResponse(diagnostic);
  return { models, status: !rawModels.length ? 'empty' : diagnostic.reasons.length ? 'partial' : 'success', diagnostic };
}

function readModelArray(value: unknown, diagnostic: ChatGptModelDiscoveryDiagnostic): unknown {
  if (Array.isArray(value)) { diagnostic.envelope = 'array'; return value; }
  if (!isPlainObject(value)) return undefined;
  // Official envelope is authoritative, even if malformed or explicitly empty.
  if (Object.hasOwn(value, 'models')) { diagnostic.envelope = 'models'; return value.models; }
  if (Object.hasOwn(value, 'data')) { diagnostic.envelope = 'data'; return value.data; }
  if (isPlainObject(value.body) && Object.hasOwn(value.body, 'models')) {
    diagnostic.envelope = 'body_models';
    return value.body.models;
  }
  return undefined;
}

function readRoutableModelId(value: unknown): string | undefined {
  const id = readNonEmptyString(value);
  // Route IDs are bounded tokens, not display labels, URLs, or arbitrary text.
  return id && id.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id) ? id : undefined;
}

function normalizeDiscoveredModel(value: unknown): ChatGptDiscoveredModel | undefined {
  if (typeof value === 'string') {
    const id = readRoutableModelId(value);
    return id ? { id } : undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as JsonObject;
  const id = readRoutableModelId(raw.slug) ?? readRoutableModelId(raw.id) ?? readRoutableModelId(raw.name) ?? readRoutableModelId(raw.model);
  if (!id) return undefined;
  const displayName = readNonEmptyString(raw.display_name) ?? readNonEmptyString(raw.displayName) ?? readNonEmptyString(raw.title) ?? readNonEmptyString(raw.name);
  const capabilities = isPlainObject(raw.capabilities) ? { ...raw.capabilities } : undefined;
  return {
    id,
    displayName,
    capabilities,
    controls: normalizeModelControls(raw, capabilities),
    raw,
  };
}

function normalizeModelControls(raw: JsonObject, capabilities: JsonObject | undefined): ChatGptModelControlCapabilities {
  const sources = [raw, capabilities].filter((source): source is JsonObject => Boolean(source));
  const supportedReasoningValue = firstDefined(sources, ['supported_reasoning_levels', 'supportedReasoningLevels']);
  const defaultReasoningValue = firstDefined(sources, ['default_reasoning_level', 'defaultReasoningLevel']);
  const supportedReasoning = normalizeReasoningOptions(supportedReasoningValue);
  const defaultEffort = readNonEmptyString(defaultReasoningValue);
  const multiAgent = firstDefined(sources, ['multi_agent_reasoning', 'multiAgentReasoning', 'multi_agent', 'multiAgent']);

  const serviceTiersValue = firstDefined(sources, ['service_tiers', 'serviceTiers']);
  const additionalSpeedTiersValue = firstDefined(sources, ['additional_speed_tiers', 'additionalSpeedTiers']);
  const serviceTiers = normalizeServiceTierOptions(serviceTiersValue, additionalSpeedTiersValue);
  const defaultTier = readNonEmptyString(firstDefined(sources, ['default_service_tier', 'defaultServiceTier']));
  const features = firstDefined(sources, ['features']);
  const fastMode = isPlainObject(features) && (features.fast_mode === true || features.fastMode === true);

  return {
    reasoning: {
      metadataKnown: Array.isArray(supportedReasoningValue) || defaultEffort !== undefined || multiAgent !== undefined,
      supported: supportedReasoning,
      defaultEffort,
      ...(multiAgent === undefined ? {} : { multiAgent }),
    },
    serviceTier: {
      metadataKnown: Array.isArray(serviceTiersValue) || Array.isArray(additionalSpeedTiersValue) || defaultTier !== undefined || fastMode,
      supported: serviceTiers,
      defaultTier,
      fastMode,
    },
  };
}

function firstDefined(sources: JsonObject[], keys: string[]): unknown {
  for (const source of sources) {
    for (const key of keys) {
      if (source[key] !== undefined) return source[key];
    }
  }
  return undefined;
}

function normalizeReasoningOptions(value: unknown): ChatGptReasoningLevelOption[] {
  if (!Array.isArray(value)) return [];
  const result: ChatGptReasoningLevelOption[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const raw = typeof item === 'string' ? { effort: item } : isPlainObject(item) ? item : undefined;
    const effort = readNonEmptyString(raw?.effort);
    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    const description = readNonEmptyString(raw?.description);
    result.push({ effort, ...(description ? { description } : {}) });
  }
  return result;
}

function normalizeServiceTierOptions(serviceTiersValue: unknown, additionalSpeedTiersValue: unknown): ChatGptServiceTierOption[] {
  const result: ChatGptServiceTierOption[] = [];
  const seen = new Set<string>();
  const append = (item: unknown) => {
    const raw = typeof item === 'string' ? { id: item } : isPlainObject(item) ? item : undefined;
    const id = readNonEmptyString(raw?.id) ?? readNonEmptyString(raw?.tier);
    if (!id || seen.has(id.toLowerCase())) return;
    seen.add(id.toLowerCase());
    const name = readNonEmptyString(raw?.name);
    const description = readNonEmptyString(raw?.description);
    result.push({ id, ...(name ? { name } : {}), ...(description ? { description } : {}) });
  };
  if (Array.isArray(serviceTiersValue)) serviceTiersValue.forEach(append);
  if (Array.isArray(additionalSpeedTiersValue)) additionalSpeedTiersValue.forEach(append);
  return result;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireSessionSecret(context?: ChatGptBackendRequestContext): ChatGptSessionSecret {
  const account = context?.account;
  if (!account) throw new Error('ChatGPT session backend requires an account context.');
  if (account.provider && account.provider !== 'chatgpt-session') throw new Error(`ChatGPT session backend requires a chatgpt-session account, got ${account.provider}.`);
  const secret = account.secret;
  if (!secret || secret.type !== 'chatgpt-session') throw new Error(`ChatGPT session account ${account.id} is missing a chatgpt-session secret.`);
  if (!secret.accessToken?.trim()) throw new Error(`ChatGPT session account ${account.id} is missing secret.accessToken.`);
  return secret;
}

/** Read at most 64 KiB; never retain raw provider text or arbitrary parameter paths. */
async function readHttpErrorDiagnostic(response: Response, lifetime: ReturnType<typeof createRequestLifetime>) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Reading the diagnostic and releasing the body share this single budget. A
  // response failure must not spend 250ms reading and another 250ms cleaning up.
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => resolve(), 250);
  });
  try {
    reader = response.body?.getReader();
    if (!reader) return undefined;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    while (true) {
      const chunk = await lifetime.run(() => Promise.race([reader!.read(), deadline]));
      if (!chunk || chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024) return undefined;
      text += decoder.decode(chunk.value, { stream: true });
    }
    const payload = parseJson(text + decoder.decode());
    const error = isPlainObject(payload?.error) ? payload.error : undefined;
    return error ? sanitizeBackendDiagnostic({ responseErrorCode: error.code, responseErrorType: error.type, responseErrorParam: error.param }) : undefined;
  } catch {
    // Invalid JSON, transport read errors and a diagnostic timeout preserve HTTP status.
    return undefined;
  } finally {
    if (reader) {
      // Cleanup is best effort; catch immediately so a late custom rejection is
      // always observed and cannot replace the already known HTTP failure.
      try {
        const cancellation = reader.cancel().catch(() => {});
        await lifetime.run(() => Promise.race([cancellation, deadline]));
      } catch { /* best-effort cleanup */ }
      finally {
        try { reader.releaseLock(); } catch { /* best-effort cleanup */ }
      }
    }
    clearTimeout(timer);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch { /* Cleanup must not replace the HTTP error. */ }
}

interface SseFrame { event?: string; data: string; }

async function* iterateSseData(response: Response, lifetime: ReturnType<typeof createRequestLifetime>): AsyncIterable<SseFrame> {
  if (!response.body) throw new ChatGptBackendError('ChatGPT session backend response body was missing.', 'invalid_response', {
    status: 502, safeDiagnostic: { httpStatus: response.status, failurePhase: 'response_body_read' },
  });
  const reader = response.body.getReader();
  // Cancel the body itself as well as fetch: custom transports may not bind the body to fetch's signal.
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    // The abort listener and finally share one teardown, including its async completion.
    // Handle rejection immediately so cleanup cannot mask the primary stream error.
    cancellation ??= Promise.resolve().then(() => reader.cancel(lifetime.signal.reason)).catch(() => {});
    return cancellation;
  };
  lifetime.signal.addEventListener('abort', cancel, { once: true });
  if (lifetime.signal.aborted) cancel();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await lifetime.run(() => reader.read());
      if (done) break;
      if (value.byteLength > 0) lifetime.activity();
      buffer += decoder.decode(value, { stream: true });
      yield* drainSseBuffer(buffer, (next) => { buffer = next; });
    }
  } finally {
    lifetime.signal.removeEventListener('abort', cancel);
    // Stop generation timers before bounded teardown, including iterator.return().
    lifetime.dispose();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([cancel(), new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 250); })]);
    } finally {
      clearTimeout(cleanupTimer);
      reader.releaseLock();
    }
  }
  buffer += decoder.decode();
  yield* drainSseBuffer(`${buffer}\n\n`, (next) => { buffer = next; });
}

function* drainSseBuffer(buffer: string, setBuffer: (value: string) => void): Iterable<SseFrame> {
  let boundary = findSseFrameBoundary(buffer);
  while (boundary) {
    const frame = buffer.slice(0, boundary.index);
    buffer = buffer.slice(boundary.index + boundary.length);
    const data = frame.split(/\r?\n/)
      .map((line) => line.startsWith('data:') ? line.slice(5).trimStart() : undefined)
      .filter((line): line is string => line !== undefined)
      .join('\n')
      .trim();
    const event = frame.split(/\r?\n/).filter((line) => line.startsWith('event:')).at(-1)?.slice(6).trim();
    if (data || event) yield { event, data };
    boundary = findSseFrameBoundary(buffer);
  }
  setBuffer(buffer);
}

function findSseFrameBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseJson(data: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : undefined;
  } catch {
    return undefined;
  }
}

function extractTextDelta(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const object = value as JsonObject;
  const candidates = [
    object.output_text_delta,
    object.delta,
    object.text,
    object.content,
    readPath(object, ['message', 'delta', 'content']),
    readPath(object, ['message', 'content']),
    readPath(object, ['response', 'output_text_delta']),
    readPath(object, ['item', 'content']),
    readPath(object, ['data', 'output_text_delta']),
  ];
  for (const candidate of candidates) {
    const text = normalizeTextCandidate(candidate);
    if (text) return text;
  }
  return undefined;
}

function normalizeTextCandidate(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(normalizeTextCandidate).filter((item): item is string => Boolean(item)).join('') || undefined;
  if (value && typeof value === 'object') {
    const raw = value as JsonObject;
    return normalizeTextCandidate(raw.text ?? raw.content ?? raw.value);
  }
  return undefined;
}

function extractToolCall(value: unknown): ChatGptToolCall | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as JsonObject;
  const candidates = [object.tool_call, object.toolCall, object.function_call, readPath(object, ['delta', 'tool_calls', '0']), readPath(object, ['message', 'tool_calls', '0']), readPath(object, ['item'])];
  for (const candidate of candidates) {
    const toolCall = normalizeToolCall(candidate);
    if (toolCall) return toolCall;
  }
  return undefined;
}

function normalizeToolCall(value: unknown): ChatGptToolCall | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as JsonObject;
  const functionObject = raw.function && typeof raw.function === 'object' && !Array.isArray(raw.function) ? raw.function as JsonObject : undefined;
  const id = readNonEmptyString(raw.call_id) ?? readNonEmptyString(raw.tool_call_id) ?? readNonEmptyString(raw.id);
  const name = readNonEmptyString(raw.name) ?? readNonEmptyString(functionObject?.name);
  if (!name) return undefined;
  const rawInput = raw.input ?? raw.arguments ?? functionObject?.arguments ?? {};
  return { id: id ?? `call_${name}`, name, input: parseToolInput(rawInput) };
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function extractFinishReason(value: JsonObject): ChatGptFinishReason | undefined {
  return readNonEmptyString(value.finish_reason) ?? readNonEmptyString(value.finishReason) ?? readNonEmptyString(readPath(value, ['response', 'finish_reason']));
}

function extractUsage(value: JsonObject): ChatGptUsage | undefined {
  const candidates = [value.usage, readPath(value, ['response', 'usage']), readPath(value, ['body', 'usage']), value.token_usage, value.tokenUsage];
  for (const candidate of candidates) {
    const usage = normalizeUsage(candidate);
    if (usage) return usage;
  }
  return undefined;
}

function normalizeUsage(value: unknown): ChatGptUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as JsonObject;
  const usage: ChatGptUsage = {
    inputTokens: readTokenCount(raw.input_tokens) ?? readTokenCount(raw.prompt_tokens),
    outputTokens: readTokenCount(raw.output_tokens) ?? readTokenCount(raw.completion_tokens),
    totalTokens: readTokenCount(raw.total_tokens),
    raw,
  };
  return usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.totalTokens !== undefined ? usage : undefined;
}

function mergeUsage(current: ChatGptUsage | undefined, next: ChatGptUsage | undefined): ChatGptUsage | undefined {
  if (!next) return current;
  if (!current) return next;
  return {
    inputTokens: next.inputTokens ?? current.inputTokens,
    outputTokens: next.outputTokens ?? current.outputTokens,
    totalTokens: next.totalTokens ?? current.totalTokens,
    raw: next.raw ?? current.raw,
  };
}

function readTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readPath(value: JsonObject, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as JsonObject)[segment];
  }
  return current;
}

function responseEventError(event: string | undefined, value: JsonObject | undefined, httpStatus: number): ChatGptBackendError | undefined {
  const type = value?.type ?? event;
  const response = isPlainObject(value?.response) ? value.response : undefined;
  const incomplete = type === 'response.incomplete' || event === 'response.incomplete' || response?.status === 'incomplete' || value?.status === 'incomplete';
  const failureTypes = ['error', 'response.error', 'response.failed', 'response.cancelled'];
  const failed = failureTypes.includes(event ?? '') || (typeof type === 'string' && failureTypes.includes(type))
    || value?.status === 'failed' || response?.status === 'failed'
    || value?.status === 'cancelled' || response?.status === 'cancelled'
    || (value?.error !== undefined && value.error !== null && value.error !== false)
    || (response?.error !== undefined && response.error !== null && response.error !== false);
  if (!incomplete && !failed) return undefined;
  const error = isPlainObject(response?.error) ? response.error : isPlainObject(value?.error) ? value.error : undefined;
  const details = isPlainObject(response?.incomplete_details) ? response.incomplete_details : undefined;
  const safeDiagnostic = sanitizeBackendDiagnostic({
    eventType: type, responseStatus: response?.status ?? value?.status, responseErrorCode: error?.code ?? (type === 'error' || event === 'error' ? value?.code : undefined),
    ...(incomplete ? { incompleteReason: details?.reason } : {}),
    httpStatus, failurePhase: incomplete ? 'response_incomplete' : 'response_event',
  });
  // Incomplete is a distinct unsuccessful terminal state, never a completed response.
  return new ChatGptBackendError(incomplete ? 'ChatGPT session backend response was incomplete.' : 'ChatGPT session backend response failed.', incomplete ? 'invalid_response' : 'upstream_error', { status: 502, safeDiagnostic });
}

function isDoneEvent(value: JsonObject): boolean {
  const type = value.type;
  return type === 'done' || type === 'response.completed' || type === 'message_stop' || value.done === true;
}
