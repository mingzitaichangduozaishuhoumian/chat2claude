import { createHash } from 'node:crypto';
import { checkWebGatewayConnection, type WebGatewayConnectionStatus } from '@chatgpt-to-claude/chatgpt-backend';
import type { BackendRoutingGateway } from './backend-routing.js';
import type { Account } from './account-pool.js';

/** Operational checks never activate a gateway or send a generation request. */
export class WebGatewayConnection {
  private cached?: { key: string; at: number; result: WebGatewayConnectionStatus };
  constructor(private readonly options: { fetch?: typeof fetch; now?: () => number } = {}) {}

  view(gateway: BackendRoutingGateway | undefined): WebGatewayConnectionStatus {
    if (!gateway) return { state: 'unconfigured' };
    if (this.cached?.key === fingerprint(gateway) && this.now() - this.cached.at < 60_000) return { ...this.cached.result };
    return { state: 'unchecked' };
  }

  async check(gateway: BackendRoutingGateway | undefined, signal?: AbortSignal): Promise<WebGatewayConnectionStatus> {
    const configuration = gateway ? structuredClone(gateway) : undefined;
    const result = await checkWebGatewayConnection({ configuration, fetch: this.options.fetch, timeoutMs: 5000, signal });
    if (configuration) this.cached = { key: fingerprint(configuration), at: this.now(), result: { ...result } };
    return result;
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
}

/** Only fixed error categories leave the server; provider text stays private. */
export function lastWebRequestFailure(account: Account | undefined): WebGatewayConnectionStatus | undefined {
  switch (account?.lastErrorCode) {
    case 'unauthorized': return { state: 'auth_failed' };
    case 'network_error': return { state: 'unreachable' };
    case 'timeout': return { state: 'timeout' };
    case 'invalid_response': return { state: 'invalid_response' };
    case 'rate_limited': return { state: 'not_ready', httpStatus: 429 };
    case 'upstream_error': return { state: 'not_ready' };
    default: return undefined;
  }
}

function fingerprint(gateway: BackendRoutingGateway): string {
  // Includes credentials to invalidate stale checks when a key is replaced.
  // The hash and configuration are never returned by this service.
  return createHash('sha256').update(JSON.stringify(gateway)).digest('hex');
}
