# Using Claude Code and the Admin Console

This guide explains how to run `chatgpt-to-claude`, complete the local Codex OAuth flow, configure Claude Code, and use the `/admin` console. All credentials in examples are placeholders.

## 1. Start the service

From the repository root, run one of the following.

Windows:

```bat
start.bat
```

Git Bash, Linux, or macOS:

```bash
./start.sh
```

Manual setup and verification:

```bash
corepack pnpm setup
corepack pnpm check
corepack pnpm start
```

The default address is `http://127.0.0.1:3000`; open:

```text
http://127.0.0.1:3000/admin
```

If you set `PORT`, replace `3000` in every example with the actual port. This guide uses `127.0.0.1` to make local-only access explicit.

The service listens on loopback by default. A non-loopback `HOST` requires `API_KEYS` at startup, plus your own firewall, reverse proxy, VPN, or other network access control.

## 2. The six Admin destinations

The Admin console has six fixed destinations. The selected destination is also reflected in the URL hash.

| Destination | Purpose |
| --- | --- |
| **Overview** `#overview` | Shows account and health summary, discovered models, available aliases, Runtime Key count, quota-cache state, and recent account activity. Recent activity is a summary, not a complete request log. |
| **Accounts & Authorization** `#authentication` | Runs Codex OAuth, restores or cancels flows, checks account health and models, reauthorizes/enables/disables/edits/deletes accounts, and exposes manual session import in Professional mode. |
| **Models** `#models` | Binds aliases to discovered backend models, changes alias enabled state and defaults, refreshes discovery, and manages custom aliases in Professional mode. |
| **API access** `#api-access` | Creates, copies, lists, and revokes Runtime API Keys; shows the dynamic Base URL, endpoint, and curl example. |
| **Quotas** `#quota` | Reads cached provider allowance data and refreshes one or all accounts. It distinguishes fresh, stale, error, and unknown states. |
| **Admin access** `#admin-access` | Prefers the host-local HttpOnly admin session. Professional mode provides an Admin API Key for external management after the operator independently makes the service reachable. |

### Simple and Professional modes

The console opens in **Simple mode**. Simple mode is sufficient for normal OAuth, backend-model binding, Runtime API Key generation, and basic status checks. It shows account identity, plan, enabled state, health, request outcomes, recent activity, and model count.

**Professional mode** additionally exposes:

- internal and upstream account IDs, credential expiry, concurrency, cooldown, and safe error codes;
- discovery attempt/success times, safe diagnostics, and the full discovered-model list;
- reasoning-effort and service-tier controls, capability metadata, and configuration issues;
- custom alias creation, editing, deletion, overlay reset, and backend-discovery refresh;
- advanced manual `accessToken`/cookie import;
- external-management Admin API Key access after the operator independently makes the service reachable.

The mode preference is stored in the current browser as `localStorage.adminViewMode` and accepts only `simple` or `professional`. It is not server-side account configuration; another browser or cleared storage returns to Simple mode.

### Language memory

The console defaults to Simplified Chinese. Click **English** in the upper-right corner to switch languages. The choice is stored in the current browser as `localStorage.adminLocale` and is reused after refresh; accepted values are `zh-CN` and `en`.

The page translates static text, ARIA attributes, dates, and numbers in place. It does not translate account labels or provider-supplied model names. The service does not persist these UI preferences in runtime state.

During an OAuth return, the page temporarily stores only `{ flowId, origin }` in `sessionStorage`, then removes `oauth_flow` from the address bar. It does not store the OAuth code, state, verifier, token, cookie, Admin Key, or Runtime Key there.

## 3. Complete Codex OAuth

The normal path is browser authorization. It does not extract a token from an already signed-in `chatgpt.com` page.

1. Open `/admin` and click **Add ChatGPT account**.
2. The page synchronously opens `about:blank` in a new tab, then requests an OAuth flow. Once the service returns the authorization URL, that tab navigates to it. The service does not start a separate Chrome process or profile.
3. Each flow receives a random flow ID, one-time OAuth `state`, and PKCE `code_verifier`/`code_challenge`. The authorization URL uses `auth.openai.com`, the configured OpenID/profile/email/offline and connector scopes, and `originator=chat2claude`.
4. The callback listener attempts to bind IPv6 `::1` (IPv6-only) and IPv4 `127.0.0.1` on the same port. The default port is `1455`; if a complete bind is not possible, the already-open sockets are closed and the whole flow moves to `1457`. If IPv6 is unavailable, IPv4 alone can be used. The service never binds a wildcard or LAN address.
5. A flow expires after ten minutes by default. A callback URL must exactly match this flow's `http://localhost:<1455|1457>/auth/callback`; duplicate/conflicting parameters and an incorrect protocol, host, port, path, userinfo, or fragment are rejected. A successful state is consumed once.
6. As soon as the callback contains a code, the service performs a single-flight code exchange instead of waiting for the next polling request. A successful listener callback redirects with `303` to `/admin?oauth_flow=<flow-id>`; the URL contains only a non-sensitive flow locator.
7. Provisioning then verifies the session, discovers backend models, persists the `chatgpt-session` account and model catalog, binds `sonnet` to the first model in the discovery order for the first session account, and creates a persistent Runtime API Key if none exists.
8. The page displays only sanitized account information, discovered models, alias bindings, Base URL, endpoint, and the one-time Runtime API Key. It never displays access tokens, refresh tokens, ID tokens, cookies, or other secrets.

If the browser cannot connect to the local callback:

1. Copy the complete `http://localhost:<port>/auth/callback?...` URL from the address bar without editing it.
2. Paste it into the callback field in **Accounts & authorization**.
3. Click **Submit callback URL**; the service validates it and continues exchange/provisioning.

Cancelling an authorization cancels only the server-side flow; it does not open or close browser windows. A service restart removes in-memory flows, so the page asks you to authorize again.

### Advanced manual import

Use **Advanced: import accessToken / cookie** only when OAuth is unavailable or you already have a usable session secret. Professional mode supports adding a session account or reauthorizing an existing `chatgpt-session` account. Manual import still runs session verification, model discovery, and the same persistence path. The form and response do not return secrets.

## 4. Runtime API Keys, Admin API Keys, and `API_KEYS`

The names describe different primary uses, and the server now enforces that Runtime API Keys are client credentials only:

| Credential | Primary use | Accepted authentication |
| --- | --- | --- |
| Runtime API Key | Client calls to `/v1/*`; rejected for protected `/admin/api/*` routes | `Authorization: Bearer <key>` or `x-api-key: <key>` |
| Admin API Key | Full-management credential for external `/admin/api/*` access after the operator independently makes the service reachable; never share it as a normal user, Claude, or API credential | `Authorization: Bearer <key>` or `x-api-key: <key>` |
| `API_KEYS` | Static server-side allow-list configured before startup; usable for `/v1/*` and remote Admin API access | Same headers |

Runtime API Key and Admin API Key are therefore separate by issuance, purpose, and authorization behavior. Normal clients should receive Runtime API Keys; Admin API Keys remain full-management credentials.

Prefer the host-local browser HttpOnly session. Use an Admin API Key from another browser, device, or automation only after the operator independently makes the service reachable through LAN, VPN/mesh VPN, an SSH tunnel, reverse tunnel/NAT traversal, or a reverse proxy. This project does not create tunnels, configure NAT, or publish the service.

On loopback, opening `/admin` issues a process-scoped random HttpOnly, `SameSite=Strict`, `Path=/admin` cookie. The cookie:

- is valid only in the current process and expires on restart;
- is accepted only for a trusted loopback Host;
- is accepted for Admin API routes, never for `/v1/*`;
- requires a same-origin `Origin` header for mutations;
- falls back to an explicit Admin API Key for remote access, automation, or an unavailable local session.

A Runtime API Key is shown in raw form only on the page that creates it. When generating a key, you may optionally assign a 1-64 character display name; names are trimmed and duplicates are rejected to avoid replacing an existing named key by accident. Later lists contain only the key ID, optional name, creation time, and safe prefix. If the raw value is lost, create a replacement and revoke the old record if necessary.

For a fixed server-side key, use a placeholder value such as:

```bash
API_KEYS='<key-1>,<key-2>' ./start.sh
```

In development, `/admin/api/api-keys/dev-enable` can create an `sk-dev-...` key. That route is disabled when `NODE_ENV=production`. Normal Runtime Keys use the `sk-runtime-...` prefix.

## 5. Base URL and Claude Code configuration

Claude Code must use the service root origin as its Base URL. **Do not append `/v1`.**

Correct:

```text
http://127.0.0.1:3000
```

Incorrect:

```text
http://127.0.0.1:3000/v1
```

The Claude Messages endpoint is `POST /v1/messages`; the client appends the path to the root Base URL. With `PORT=3100`, use `http://127.0.0.1:3100`.

### Temporary environment variables

PowerShell:

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3000"
$env:ANTHROPIC_AUTH_TOKEN = "<runtime-api-key>"
claude
```

CMD:

```bat
set "ANTHROPIC_BASE_URL=http://127.0.0.1:3000"
set "ANTHROPIC_AUTH_TOKEN=<runtime-api-key>"
claude
```

Git Bash, Linux, or macOS:

```bash
export ANTHROPIC_BASE_URL='http://127.0.0.1:3000'
export ANTHROPIC_AUTH_TOKEN='<runtime-api-key>'
claude
```

`ANTHROPIC_AUTH_TOKEN` is sent as a Bearer token. Configure a Runtime API Key, not an Admin API Key.

### Safe environment check

PowerShell:

```powershell
if ([string]::IsNullOrWhiteSpace($env:ANTHROPIC_BASE_URL)) { throw "ANTHROPIC_BASE_URL is not set" }
if ([string]::IsNullOrWhiteSpace($env:ANTHROPIC_AUTH_TOKEN)) { throw "ANTHROPIC_AUTH_TOKEN is not set" }
Write-Output "ANTHROPIC_BASE_URL=$env:ANTHROPIC_BASE_URL"
Write-Output "ANTHROPIC_AUTH_TOKEN=set (value hidden)"
Invoke-RestMethod "$env:ANTHROPIC_BASE_URL/healthz" | Out-Null
Write-Output "healthz=OK"
```

Git Bash, Linux, or macOS:

```bash
: "${ANTHROPIC_BASE_URL:?ANTHROPIC_BASE_URL is not set}"
: "${ANTHROPIC_AUTH_TOKEN:?ANTHROPIC_AUTH_TOKEN is not set}"
printf 'ANTHROPIC_BASE_URL=%s\n' "$ANTHROPIC_BASE_URL"
printf 'ANTHROPIC_AUTH_TOKEN=set (value hidden)\n'
curl --fail "$ANTHROPIC_BASE_URL/healthz"
```

### Claude Code settings example

```json
{
  "model": "sonnet",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3000",
    "ANTHROPIC_AUTH_TOKEN": "<runtime-api-key>",
    "ANTHROPIC_MODEL": "sonnet",
    "ANTHROPIC_REASONING_MODEL": "sonnet",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "opus",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "sonnet",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "haiku",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "fable"
  }
}
```

This maps the Claude Code model roles to the project's aliases. If an alias is unbound, bind it in **Model mapping** before using it. This file contains credentials; do not commit or share it. Restart the existing Claude Code session after changing settings.

### Compatibility cookbook

The base URL must match the client family. A root URL is correct for clients that append `/v1/...` themselves, including Claude Code and the Anthropic TypeScript SDK. An OpenAI-compatible client normally expects the versioned base URL ending in `/v1`. Do not use the root URL with a client that does not append `/v1`, and do not add `/v1` twice.

Claude Code uses the root URL shown above. For an Anthropic TypeScript SDK client, use the same root URL:

```ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'http://127.0.0.1:3000',
  apiKey: '<runtime-api-key>',
});
const message = await client.messages.create({
  model: 'sonnet', max_tokens: 64,
  messages: [{ role: 'user', content: 'Hello' }],
});
```

For the OpenAI TypeScript SDK, use the versioned URL and one of the supported OpenAI-compatible routes:

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:3000/v1',
  apiKey: '<runtime-api-key>',
});
const completion = await client.chat.completions.create({
  model: 'sonnet', messages: [{ role: 'user', content: 'Hello' }],
});
```

`POST /v1/messages/count_tokens` returns only `{ "input_tokens": number }`. It is a local heuristic, not Anthropic tokenizer parity; successful responses include `x-chat2claude-token-count-mode: heuristic`. `GET /v1/models` keeps the OpenAI-style top-level shape `{ "data": [...] }`; each listed model may include project metadata such as capabilities and `token_counting_mode`.

### Real-client smoke matrix

Use a Runtime API Key for all client smoke checks; do not use an Admin API Key as a normal client credential.

| Client | Base URL | Primary smoke endpoints |
| --- | --- | --- |
| Claude Code | `http://127.0.0.1:3000` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models` |
| Anthropic SDK | `http://127.0.0.1:3000` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models` |
| OpenAI SDK | `http://127.0.0.1:3000/v1` | `/v1/chat/completions`, `/v1/responses`, `/v1/models` |
| Cline | `http://127.0.0.1:3000` | `/v1/messages`, `/v1/models` |
| Roo | `http://127.0.0.1:3000` | `/v1/messages`, `/v1/models` |
| Continue | `http://127.0.0.1:3000/v1` | `/v1/chat/completions`, `/v1/models` |
| Cherry Studio | `http://127.0.0.1:3000/v1` | `/v1/chat/completions`, `/v1/models` |

Claude Code, Anthropic SDK, Cline, and Roo should be configured as Claude/Anthropic-compatible clients with the root origin. OpenAI SDK, Continue, and Cherry Studio should be configured as OpenAI-compatible clients with the versioned `/v1` origin.

## 6. Model aliases, discovery, and reasoning/speed controls

### Built-in aliases

| Alias | Default reasoning effort | Initial behavior |
| --- | --- | --- |
| `sonnet` | `medium` | First session provisioning binds it to the first discovered backend model. Start with this alias. |
| `haiku` | `low` | Built in but commonly unbound; select a discovered backend model first. |
| `fable` | `high` | Configurable built-in alias, not a hard-coded production model ID; bind it before use. |
| `opus` | `high` | Built in but commonly unbound; bind it before use. |

The backend model list is not a static source-code table:

- If present, `MODEL_REGISTRY_JSON` is the alias-overlay source; otherwise `config/models.json` is used.
- The session backend discovers models with an account context; startup discovery without an account may be empty.
- The mock backend can use `MOCK_BACKEND_MODELS_JSON` for discovery.
- OAuth provisioning and account health/model refresh update the account-scoped catalog.
- `GET /v1/models` returns only enabled, resolvable aliases (`bound`) and discovery passthrough models (`passthrough`); `unbound` and `stale` entries are omitted. Each entry includes `capabilities`, a stable `capability_projection` derived from runtime model metadata, and `token_counting_mode: "heuristic"`; the top-level shape remains `{ "data": [...] }`.
- Existing persistent or manually selected alias bindings are not arbitrarily overwritten by a restart discovery refresh; refresh only binds when a binding is needed.

The Backend Model choices in Admin come from the current discovery catalog. Professional mode also exposes the target model's reasoning-effort and service-tier metadata. When metadata is unknown, the service does not assume that every control is supported. An explicit unsupported `reasoning_effort` or service tier returns HTTP 400 instead of being silently rewritten.

### Token counting

`POST /v1/messages/count_tokens` preserves the Claude-compatible body shape exactly:

```json
{ "input_tokens": 123 }
```

The value is a local heuristic rather than Anthropic tokenizer parity. Successful responses include `x-chat2claude-token-count-mode: heuristic`; clients that need tokenizer-exact billing or limits must not treat it as an Anthropic count.

## 7. Quotas, logs, and timing boundaries

### Quotas

The first quota-panel load reads the local cache and does not call the provider. Refreshes are deduplicated per account; a batch refresh may partially succeed. The UI identifies the five-hour window from `durationSeconds=18000` and the weekly window from `durationSeconds=604800`; other provider meters are shown as returned.

Missing or unknown `usedPercent` is not rendered as a zero-value progress bar. The UI does not infer allowance from plan names, 429 responses, or request counts. Quota results are classified as `fresh`, `stale`, `error`, or `unknown`; an account without provider quota support is shown as unsupported.

### Optional outbound proxy (Clash)

Set `OUTBOUND_PROXY_URL=http://127.0.0.1:7890` for the local Clash mixed port (no authentication required); `http://127.0.0.1:7892` can be used for its HTTP port. Leave it unset or empty for direct connections. Only HTTP/HTTPS proxy URLs are accepted; SOCKS URLs, paths, queries, and fragments are rejected with a fixed safe error. URL credentials are supported but must be treated as secrets, never pasted into logs or shared screenshots.

The app uses external Undici 7 `ProxyAgent`, compatible with Node 22.15, through an explicit fetch dispatcher for ChatGPT/Codex requests: completions/SSE, model discovery, health checks, quotas/reset credits, OAuth code exchange and token refresh. It does not set a global dispatcher, depend on `NODE_USE_ENV_PROXY`, or proxy local Hono requests, OAuth loopback callbacks, or browser navigation. The dispatcher closes on app disposal. The proxy URL is not exposed in logs, Admin APIs, or the DOM.

### HTTP access logs

Access logging is installed only for `/v1/*` and `/admin/api/*`. The default `ACCESS_LOG_FORMAT=text` emits aligned arrows: `[...] <-- METHOD path` at request start and `[...] --> STATUS [STREAMING] | duration | METHOD path?query` when the response is ready. SSE is logged at readiness without reading, cloning, teeing, or delaying the body. Text mode avoids stream lifecycle noise and emits one real terminal line after stream cleanup: `STREAM DONE`, `STREAM CANCELLED`, or `STREAM FAILED`, with aggregate counts/bytes/duration. `simple` normalizes to `text`; `detailed`/`json` may retain safe structured fields, the initial `STREAM START` lifecycle entry, and terminal fields; fixed-interval `STREAM ACTIVE` logs are not emitted. Logs never contain prompts, tool arguments/results, encrypted content, raw provider payloads, headers, tokens, cookies, session, or proxy credentials.

```text
[2026-09-08 13:12:03] [c6a432ed] [INFO ] [  api  ] <-- POST /v1/messages?beta
[2026-09-08 13:12:08] [c6a432ed] [INFO ] [ opus  ] --> 200 STREAMING | 4.681s | POST /v1/messages?beta
[2026-09-08 13:12:21] [c6a432ed] [ERROR] [ opus  ] --> STREAM FAILED | 17.598s | events=42 bytes=8192 | invalid_response
```

Text uses host-local `YYYY-MM-DD HH:mm:ss`; JSON time remains ISO UTC. Fixed columns are timestamp, the first 8 characters of the server-generated UUID, uppercase level (5 characters), centered model/category (7 characters), and arrow. Model text is control-sanitized before truncation; when the model is unknown, the normalized path determines the safe category: `/v1/*` is `api`, `/admin/*` is `admin`, and everything else is `system`. Durations use seconds with three decimals. Both arrows include safe query categories (`beta` / `other`, never values). Text includes no source filename or IP. Structured peer IP comes only from the connection, not forwarding headers. Structured entries contain:

- request ID, HTTP method, and normalized path;
- query-parameter categories (`beta` is retained; all other names become `other`);
- HTTP status and peer IP;
- model ID and stream flag only after route validation;
- `durationMs` and `durationKind: response_ready | stream_lifecycle | stream_terminal`.

The logger does **not** read or record request bodies, response bodies, tokens, cookies, Authorization headers, API Keys, OAuth code/state/verifier values, or complete query values. Dynamic flow/account/key/model IDs are normalized to placeholders; invalid or oversized model IDs are replaced with a safe placeholder.

All three protocols preserve the existing readiness barrier: a validated upstream frame precedes SSE 200/prelude. This 200 means response-ready, not guaranteed success. Non-stream requests use `durationKind: response_ready`. Streams finalize exactly once after cleanup. Concise text emits exactly one terminal line: `STREAM DONE`, `STREAM CANCELLED`, or safe `STREAM FAILED`. Detailed/JSON retain all terminal outcomes and safe metrics with `durationKind: stream_terminal`, measured from request entry including account waiting. Late failures retain HTTP 200. Fixed allowlisted `protocolStage` / `protocolReason` diagnostics distinguish malformed SSE JSON, invalid lifecycle/text/part/output item, incomplete, missing successful terminal, tool finalization, and replay snapshot errors; provider message/detail/raw param/payload are never logged. EOF/`[DONE]` is not success. Custom backend done events may still omit `terminalSuccessful`; explicit false fails. Silent upstream periods emit `: keepalive` SSE comments every 15 seconds by default (`SSE_KEEPALIVE_INTERVAL_MS=0` disables them), and keepalives stop on success, cancellation, or error. Actual client disconnect closes HTTP delivery gracefully, cancels upstream and releases the account without a fresh AbortError writer stack. Internal teardown abort is not evidence of client cancellation; upstream AbortError, timeout and protocol errors remain failures. Pre-response cancellation stays 499 (account acquisition keeps its existing 503). Logger/statistics failures cannot prevent release. Middleware never reads, clones or tees the body.

Claude terminal metadata includes only numeric/boolean size metrics: sourceMessageCount (messages length), sourceContentBlockCount (string counts as one block; system excluded), upstreamBodyBytes (exact UTF-8 bytes of the single final JSON string sent to fetch), toolCount, toolSchemaBytes (sum of schema JSON UTF-8 bytes), upstreamInputItemCount, replayItemCount and replayApplied. System/history/tool arguments/images/ciphertext contribute to wire size, never to log content. Internal callbacks carry these fields; client JSON cannot forge them, and the log boundary allowlists them again. Wire sizes are computed before fetch, so failures/timeouts retain known metrics. JSON keeps all numeric metadata; detailed text shows key fields. Standalone routes without access middleware retain safe terminal application events as a compatibility fallback.

Request release keeps `unauthorized` accounts unhealthy until a successful health check or reauthorization, and `rate_limited` accounts in cooldown. `network_error`, `timeout`, `upstream_error`, and `invalid_response` retain only a fixed local diagnostic and safe code; otherwise healthy accounts remain available for immediate reacquisition. `invalid_request` clears transient diagnostics without poisoning health. Successful or request-scoped releases never clear a concurrent unhealthy/cooldown decision. Explicit health-check failures may still set `error`.

### Bounded account-concurrency waiting

Messages, Chat Completions, and Responses use the same notification-based acquisition policy. If at least one account matches provider, capability, model, and controls and is otherwise available but saturated, the request waits for a slot rather than returning an immediate 503. `ACCOUNT_ACQUIRE_TIMEOUT_MS` defaults to `30000`; `0` restores immediate failure. It accepts integer milliseconds from `0` to `2147483647`; invalid values fail startup. Waiting has one fixed deadline, with no polling and no deadline reset on notification.

Release, health recovery, enablement, removal, and configuration updates notify existing waiters. Each waiter competes through synchronous acquisition, which still enforces Admin's `maxConcurrency` limit. Timeout, acquisition, cancellation via the request's AbortSignal, and a change to a non-busy unavailable state remove the waiter, its timer, and abort listener. The pool does not wait for cooldown expiry, reauthorization, or incompatible models to change.

| Fixed reason | Meaning |
| --- | --- |
| `no_account` | No account matches the provider. |
| `capability_unavailable` | No provider-matching account has the required capability. |
| `model_or_controls_unsupported` | No candidate supports the requested model/controls. |
| `account_disabled` | Matching accounts are disabled. |
| `account_unhealthy` | Enabled matching accounts are unhealthy (for example, unauthorized credentials). |
| `account_error` | After excluding unhealthy accounts, remaining matching accounts are in error (for example, a failed manual health check). |
| `account_cooldown` | Remaining matching accounts are cooling down. |
| `account_busy` | Otherwise available matching accounts are saturated and waiting is disabled. |
| `account_busy_timeout` | The slot-acquisition deadline expired. |
| `request_aborted` | The client cancelled during acquisition. |

Diagnosis applies provider, capability, eligibility, enabled, health, cooldown, and concurrency filters in that order. This makes mixed-pool failures deterministic: an incompatible idle account cannot hide an eligible busy account. A session preflight preserves the existing no-available-account 503 before global model resolution, but allows busy accounts through for full model/control filtering. Existing model-validation 400/404 responses remain unchanged.

Reasons are internal/log metadata, not account IDs, raw errors, upstream response bodies, or new API/SSE fields. Acquisition failures retain HTTP 503 / `overloaded_error` in each protocol's existing envelope. An already-disconnected client may not receive that response. A streaming response's initial 200 does **not** free the account: its generator's `finally` releases the slot when the SSE finishes, errors, or is cleaned up after cancellation. Access-log duration includes acquisition waiting and the entire SSE iterator lifetime through terminal cleanup, not just upstream latency.

### Admin request statistics

Account-card success, failure, cancellation, total-request, token, last-request, and in-flight values come from separate operational statistics, not from the complete access log. Operational state is debounced into `admin-operational-state.json`; `inFlight` is not persisted and returns to zero after restart. A statistics persistence failure does not change the provider response, account release, or cooldown behavior. `/metrics` remains JSON and returns bounded request-log aggregates (retained count, stream count, and route counts), plus aggregate operational account/request/token counters when operational state is configured. It never returns request content, headers, cookies, tokens, tool arguments, or secrets. Operators using the local Admin session or a server `API_KEYS` Admin key can call `GET /admin/api/diagnostics/requests` for the same bounded safe metadata only: route, model, stream flag, and timestamp. Runtime API Keys are rejected for this global inspector so one client cannot read another client's request metadata.

## 8. Persistence, encryption, and secret handling

The default data directory is the API application's `data` directory. Set a custom directory with:

```bash
DATA_DIR=./custom-data
```

`${DATA_DIR}/runtime-state.json` stores account session secrets, Runtime API Keys, and alias overlays. `${DATA_DIR}/admin-operational-state.json` stores sanitized request statistics, health, discovery catalogs, and quota cache. Writes use temporary files, fsync, and atomic rename; the service attempts to use directory mode `0700` and file mode `0600`.

If `STATE_ENCRYPTION_KEY` is set, runtime state is encrypted with AES-256-GCM. It must be a strict standard-base64 encoding of a 32-byte key (44 characters ending in one `=`). Generate a local value with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Put the complete output in a local `.env` file. Never put it in documentation or commits. An encrypted state file requires the same key at startup; a missing or mismatched key prevents the state from being loaded.

## 9. Environment variables

Common settings:

```bash
CHATGPT_BACKEND=session
CHATGPT_BASE_URL=https://chatgpt.com
CHATGPT_REQUEST_TIMEOUT_MS=60000
CHATGPT_RESPONSE_HEADER_TIMEOUT_MS=60000
CHATGPT_STREAM_IDLE_TIMEOUT_MS=300000
CHATGPT_STREAM_TOTAL_TIMEOUT_MS=0
SSE_KEEPALIVE_INTERVAL_MS=15000
ACCESS_LOG_FORMAT=text
ACCOUNT_ACQUIRE_TIMEOUT_MS=30000
PORT=3000
HOST=127.0.0.1
API_KEYS=<key-1>,<key-2>
```

Session generation is decoupled from short operations. `CHATGPT_REQUEST_TIMEOUT_MS` defaults to 60000 and remains for OAuth/token/discovery/quota operations. `CHATGPT_RESPONSE_HEADER_TIMEOUT_MS` defaults to 60000 and bounds fetch-to-headers. `CHATGPT_STREAM_IDLE_TIMEOUT_MS` defaults to 300000: it starts at headers and resets on every nonempty raw body chunk, including reasoning, tools, SSE comments and split frames; empty chunks do not reset it. `CHATGPT_STREAM_TOTAL_TIMEOUT_MS` defaults to 0, explicitly disabling the absolute generation limit; a positive value bounds the entire fetch/generation even while active. Header/idle accept integers 1..2147483647; total also accepts 0. Invalid values fail startup. Timeouts remain backend code=timeout/status=504 with allowlisted timeoutKind=response_headers | stream_idle | stream_total. Caller cancellation wins and does not mark the account failed. Reader cancellation cleanup waits at most 250ms.

Package migration: deprecated `timeoutMs` alone preserves its legacy absolute generation and short-operation limits. Supplying any new field selects phased semantics, with total disabled unless specified; `requestTimeoutMs` affects short operations only. The API explicitly supplies the new fields and never uses the old environment variable as a generation limit.

`CHATGPT_BASE_URL` is the upstream URL used by the session backend for `/backend-api/codex/responses` and model discovery. It is not the client Base URL for Claude Code. Claude Code still uses the service root origin, for example `http://127.0.0.1:3000`.

## 10. Verify a connection

```bash
curl http://127.0.0.1:3000/healthz

curl http://127.0.0.1:3000/v1/models \
  -H 'Authorization: Bearer <runtime-api-key>'

curl http://127.0.0.1:3000/v1/messages \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <runtime-api-key>' \
  -d '{"model":"sonnet","max_tokens":64,"messages":[{"role":"user","content":"Hello"}]}'
```

If `GET /v1/models` does not contain `sonnet`, refresh discovery in Admin and confirm that the alias is enabled, bound, and still points to an available backend model.

## 11. Troubleshooting

| Symptom | Resolution |
| --- | --- |
| `/v1/*` returns 401 | Use a Runtime API Key or `API_KEYS`; the browser Admin cookie is not accepted by `/v1/*`. |
| Admin mutation returns 401/403 | The local session may have expired; use the Professional-mode Admin API Key fallback. Cookie mutations also require a same-origin `Origin`. |
| The URL contains a repeated `/v1` | `ANTHROPIC_BASE_URL` incorrectly includes `/v1`; use the service root origin. |
| `message.role must be user or assistant` | Claude Messages `messages` may contain only `user` and `assistant`; put system instructions in the top-level `system` field. Do not send Claude Code traffic to the OpenAI-compatible route. |
| An alias is unbound, stale, or disabled | Refresh discovery, select an available backend model, enable the alias, and save it in **Model mapping**. |
| OAuth callback cannot connect to localhost | Paste the complete callback URL into **Accounts & authorization**; the service validates its redirect URI, state, and parameters. |
| Quota is unknown or stale | This reflects the provider response. Refresh the account or all accounts; do not interpret unknown as zero. |
| Language or mode is forgotten after restart | Language and mode are browser-local `localStorage` preferences; another browser, cleared site storage, or private browsing restores the defaults. |

## 12. Verification commands

```bash
corepack pnpm test
corepack pnpm build
corepack pnpm typecheck
```
