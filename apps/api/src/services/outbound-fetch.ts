import { ProxyAgent } from 'undici';
import { parseOutboundProxyUrl } from '../config/env.js';

export interface OutboundTransport {
  fetch: typeof fetch;
  close(): Promise<void>;
}

/** App-owned dispatcher for provider traffic only; no global fetch/dispatcher mutation. */
export function createOutboundTransport(proxyUrl?: string, fetchImpl: typeof fetch = fetch): OutboundTransport {
  const uri = parseOutboundProxyUrl(proxyUrl);
  if (!uri) return { fetch: fetchImpl, close: async () => {} };
  let dispatcher: ProxyAgent;
  try {
    const proxy = new URL(uri);
    const username = decodeURIComponent(proxy.username);
    const password = decodeURIComponent(proxy.password);
    // Keep credentials out of the proxy URI and provide the RFC 7617 value
    // explicitly. This preserves an intentionally empty password (for example,
    // http://user:@proxy:7890), which ProxyAgent's URI parsing otherwise drops.
    proxy.username = '';
    proxy.password = '';
    const token = (username || password) ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : undefined;
    dispatcher = new ProxyAgent({ uri: proxy.toString(), ...(token ? { token } : {}) });
  } catch {
    // Proxy URLs may contain credentials. Never retain constructor messages/causes.
    throw new Error('Unable to initialize outbound proxy.');
  }
  let closing: Promise<void> | undefined;
  return {
    fetch: (input, init) => {
      // Node 22's fetch uses undici-types 6; external Undici 7 dispatchers are runtime
      // compatible. Keep the type bridge at this boundary and native Response objects.
      const options: RequestInit = { ...init, dispatcher: dispatcher as unknown as RequestInit['dispatcher'] };
      return fetchImpl(input, options);
    },
    close: () => closing ??= dispatcher.close(),
  };
}
