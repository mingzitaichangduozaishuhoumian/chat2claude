import { ChatGptBackendError, normalizeCodexClientVersion, type ChatGptBackendClient, type ChatGptBackendRequestContext, type ChatGptModelDiscoveryDiagnostic, type ChatGptModelDiscoveryResult } from '@chatgpt-to-claude/chatgpt-backend';

export interface ModelDiscoveryState {
  status: 'unknown' | 'success' | 'empty' | 'partial' | 'error';
  attemptedAt: string | null;
  succeededAt: string | null;
  stale: boolean;
  error?: 'invalid_response' | 'transport';
  diagnostic?: ChatGptModelDiscoveryDiagnostic;
}

export function unknownDiscovery(): ModelDiscoveryState {
  return { status: 'unknown', attemptedAt: null, succeededAt: null, stale: false };
}

/** Compatibility backends cannot prove that an empty legacy list is provider-explicit. */
export async function discoverAccountModels(backend: ChatGptBackendClient, context: ChatGptBackendRequestContext): Promise<ChatGptModelDiscoveryResult> {
  if (backend.discoverModels) {
    const result = await backend.discoverModels(context);
    return { status: result.status, models: result.models, ...(result.diagnostic ? { diagnostic: safeDiscoveryDiagnostic(result.diagnostic) } : {}) };
  }
  const models = await backend.listModels(context);
  return { models, status: models.length ? 'success' : 'unknown' };
}

export function discoveryFailure(error: unknown): Pick<ModelDiscoveryState, 'error' | 'diagnostic'> {
  let diagnostic: ChatGptModelDiscoveryDiagnostic | undefined;
  if (error instanceof ChatGptBackendError && error.discoveryDiagnostic) {
    try { diagnostic = safeDiscoveryDiagnostic(error.discoveryDiagnostic); }
    catch { /* Invalid diagnostic metadata is omitted, never surfaced verbatim. */ }
  }
  return {
    error: error instanceof ChatGptBackendError && error.code === 'invalid_response' ? 'invalid_response' : 'transport',
    ...(diagnostic ? { diagnostic } : {}),
  };
}

/** Reconstruct, never spread provider objects into operational metadata. */
export function safeDiscoveryDiagnostic(value: ChatGptModelDiscoveryDiagnostic): ChatGptModelDiscoveryDiagnostic {
  const choice = <T extends string>(value: unknown, allowed: readonly T[]): T => {
    if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error('Invalid discovery diagnostic enum.');
    return value as T;
  };
  const count = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid discovery diagnostic count.');
    return value;
  };
  if (typeof value.clientVersion !== 'string') throw new Error('Invalid discovery client version.');
  const clientVersion = normalizeCodexClientVersion(value.clientVersion);
  if (value.httpStatus !== undefined && (!Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599)) throw new Error('Invalid discovery HTTP status.');
  return {
    clientVersion,
    ...(value.httpStatus === undefined ? {} : { httpStatus: value.httpStatus }),
    contentType: choice(value.contentType, ['json', 'event_stream', 'html', 'other', 'missing']),
    envelope: choice(value.envelope, ['models', 'data', 'body_models', 'array', 'unknown']),
    candidateCount: count(value.candidateCount), acceptedCount: count(value.acceptedCount),
    rejectedCount: count(value.rejectedCount), duplicateCount: count(value.duplicateCount),
    reasons: value.reasons.map((reason) => choice(reason, ['unknown_envelope', 'invalid_model_array', 'invalid_model_id', 'duplicate_model_id', 'invalid_json'])),
  };
}

export function discoveryMessage(state: ModelDiscoveryState, count: number): string {
  if (state.status === 'error') return state.stale
    ? `最新刷新失败，继续使用 ${count} 个缓存模型`
    : state.error === 'invalid_response' ? '模型响应格式不兼容；尚无已验证目录' : '模型发现失败；尚无已验证目录';
  if (state.status === 'empty') return '上游明确返回空目录';
  if (state.status === 'partial') return `已接受 ${count} 个账号级模型；部分条目被安全忽略`;
  if (state.status === 'success') return `已发现 ${count} 个账号级模型`;
  return count ? `发现状态未知；保留 ${count} 个缓存模型` : '模型发现状态未知；尚无已验证目录';
}
