# chatgpt-to-claude

[中文](README.md) | **English**

`chatgpt-to-claude` is a TypeScript + Hono local compatibility layer. It exposes Claude Messages, OpenAI Chat Completions, OpenAI Responses, Models API, and related compatibility routes while connecting internally to either a mock backend or a real ChatGPT/Codex session backend.

This project is intended for personal local/private use with ChatGPT/Codex accounts that you own or are explicitly authorized to operate. It is **not** a subscription resale service, public proxy, multi-tenant gateway, or traffic aggregation business. Do not resell personal subscription traffic or expose it to untrusted third parties at scale.

## What makes this project different

`chatgpt-to-claude` has a deliberately narrow position: it is a **local, lightweight ChatGPT/Codex to Claude/OpenAI-compatible API adapter**. It turns a ChatGPT/Codex account session that you control into interfaces that Claude Code, Anthropic SDK, OpenAI SDK, and OpenAI-compatible clients can use directly.

It is not a large all-in-one proxy gateway, and it is not trying to become the biggest proxy hub. The tradeoff is intentional: run locally or in a private environment, listen on `127.0.0.1` by default, and solve personal developer-tool integration with as little operational burden as possible.

It is built for practical problems like these:

- You have a ChatGPT/Codex account that you own or are authorized to operate, but your clients expect Claude-style or OpenAI-style APIs.
- You want Claude Code, Anthropic SDK, OpenAI SDK, Continue, Cherry Studio, and similar clients to share one local service.
- You do not want OAuth, tokens, cookies, model discovery, alias binding, and Runtime API Keys scattered across every client configuration.
- You want local `/admin` to centralize authorization, model discovery, alias binding, and Runtime API Key creation without operating heavy gateway infrastructure.

Design tradeoffs:

- **Local/personal use first**: the service listens on `127.0.0.1` by default and is designed for a personal machine or private network. It is not for public proxying, subscription resale, traffic aggregation, or multi-tenant billing.
- **Low operational burden**: the recommended path is Node.js + pnpm + the local `/admin` console. No database, Redis, Kubernetes, service mesh, or heavyweight API gateway is required to get started.
- **Configuration lives in `/admin`**: account OAuth, model discovery, alias binding, Runtime API Key creation, and basic diagnostics are concentrated in the local Admin console, reducing manual config edits and secret copying across tools.
- **Client-friendly surface**: one local service exposes Claude Messages, OpenAI Chat Completions, OpenAI Responses, and Models API routes for Claude Code, Anthropic SDK, OpenAI SDK, and OpenAI-compatible clients.
- **Lightweight does not mean toy**: the project still keeps OAuth/session maintenance, model aliases, Runtime/Admin key separation, stream-state tracking, request terminal-state accounting, and safe logging boundaries.
- **Clear permission boundaries**: Runtime API Keys are for normal `/v1/*` clients only. Admin API Keys / configured `API_KEYS` are required for account management and global diagnostics; protected Admin APIs reject Runtime Keys.
- **Logs are useful without leaking content**: logs keep timing, stream terminal state, event/byte counts, safe error categories, and diagnostics; they do not record prompts, tool arguments/results, raw provider payloads, Authorization headers, cookies, tokens, or proxy credentials.

In short: it is not trying to pack every proxy feature into one large platform. It adapts a **personal ChatGPT/Codex account session** into a local Claude/OpenAI-compatible API with stable behavior, clear boundaries, and low operational overhead.

## Quick start

Windows:

```bat
start.bat
```

Git Bash, Linux, or macOS:

```bash
./start.sh
```

Manual setup, verification, and startup:

```bash
corepack pnpm setup
corepack pnpm check
corepack pnpm start
```

Default address:

```text
http://127.0.0.1:3000
```

Open the Admin console:

```text
http://127.0.0.1:3000/admin
```

The default backend is `mock`. For normal ChatGPT/Codex session usage, open `/admin` to complete account authorization, model discovery, and Runtime API Key creation.

### Custom port and host

The default port is `3000`. If it is already in use, or if you want to run multiple instances, set `PORT`.

Git Bash, Linux, or macOS:

```bash
PORT=3100 corepack pnpm start
```

PowerShell:

```powershell
$env:PORT = "3100"
corepack pnpm start
```

CMD:

```bat
set "PORT=3100"
corepack pnpm start
```

After changing the port to `3100`, update every client URL accordingly:

| Purpose | URL |
| --- | --- |
| Admin console | `http://127.0.0.1:3100/admin` |
| Claude Code / Anthropic SDK Base URL | `http://127.0.0.1:3100` |
| OpenAI SDK / OpenAI-compatible Base URL | `http://127.0.0.1:3100/v1` |
| Health check | `http://127.0.0.1:3100/healthz` |

The default `HOST=127.0.0.1` allows local-machine access only. For normal personal use, do not change `HOST`. If you bind to a non-loopback address such as `0.0.0.0`, preconfigure `API_KEYS` and provide your own firewall, reverse proxy, VPN, or other network access control. This project does not publish the service for you.

## First setup flow

1. Open `/admin`.
2. Click **Add ChatGPT account**.
3. Complete the Codex OAuth flow in the current browser.
4. Wait for the service to verify the session, discover backend models, persist the account, and initialize model aliases.
5. Go to **API access**.
6. Generate a Runtime API Key. You may give it a name such as `laptop`, `claude-code`, or `local-dev`.
7. Copy the raw Runtime API Key immediately. It is shown only once.
8. Use the generated Base URL, endpoint, and curl examples to call `/v1/messages`, `/v1/models`, or OpenAI-compatible routes.

OAuth does not launch a separate Chrome profile. If the browser blocks the popup or cannot reach the local callback, use the retained authorization link, copy the full callback URL, or paste the callback URL back into the Admin page. Manual access-token/cookie import is only an advanced fallback.

## Admin console

The Admin console has six main areas:

1. **Overview**: account readiness, dynamic models, available aliases, Runtime Key count, quota-cache state, and recent account activity summary.
2. **Accounts & Authorization**: Codex OAuth, flow recovery/cancel, account health/model checks, reauthorization, enable/disable, editing and deletion; Professional mode exposes manual session import.
3. **Models**: bind discovered backend models to aliases, refresh discovery, enable/disable aliases, set defaults, and manage custom aliases in Professional mode.
4. **API Access**: create, name, copy, list, and revoke Runtime API Keys; view Base URL, endpoint, and dynamic curl examples.
5. **Quotas**: read cached provider allowance information and refresh one account or all accounts, distinguishing fresh, stale, error, and unknown states.
6. **Admin Access**: prefer the local HttpOnly admin session; Professional mode exposes an Admin API Key fallback after you independently make the service reachable.

The console opens in Simple mode. Professional mode adds internal IDs, upstream IDs, concurrency/cooldown details, safe error codes, discovery diagnostics, full dynamic model catalogs, reasoning/service-tier controls, custom aliases, manual session import, and Admin API Key fallback.

## API authentication and key types

`/v1/*` accepts Runtime API Keys or preconfigured `API_KEYS`. Use either:

```text
Authorization: Bearer <runtime-api-key>
```

or:

```text
x-api-key: <runtime-api-key>
```

| Type | Purpose | Notes |
| --- | --- | --- |
| Runtime API Key | Normal client calls to `/v1/*` | Can be named and revoked; protected `/admin/api/*` routes reject Runtime Keys. |
| Admin API Key | External management for `/admin/api/*` | Full management permission; do not give it to normal clients, Claude, or third-party tools. |
| `API_KEYS` | Server-side allow-list configured before startup | Can be used for `/v1/*` and remote Admin management. |

Security boundaries:

- Local `/admin` prefers an HttpOnly, `SameSite=Strict` local admin cookie.
- The cookie is process-scoped and expires on service restart.
- Non-loopback deployments must preconfigure `API_KEYS` and provide their own firewall, reverse proxy, VPN, or other network access control.
- OAuth access tokens, refresh tokens, ID tokens, cookies, and other session secrets are not returned to the frontend, error responses, or access logs.

## Client configuration

### Base URL rules

Claude / Anthropic-compatible clients use the service root origin:

```text
http://127.0.0.1:3000
```

Do **not** append `/v1` for Claude Code or the Anthropic SDK.

OpenAI-compatible clients usually use the versioned `/v1` origin:

```text
http://127.0.0.1:3000/v1
```

### Claude Code

Git Bash, Linux, or macOS:

```bash
export ANTHROPIC_BASE_URL='http://127.0.0.1:3000'
export ANTHROPIC_AUTH_TOKEN='<runtime-api-key>'
claude
```

PowerShell:

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3000"
$env:ANTHROPIC_AUTH_TOKEN = "<runtime-api-key>"
claude
```

### Anthropic TypeScript SDK

```ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'http://127.0.0.1:3000',
  apiKey: '<runtime-api-key>',
});

const message = await client.messages.create({
  model: 'sonnet',
  max_tokens: 128,
  messages: [{ role: 'user', content: 'Hello' }],
});
```

### OpenAI TypeScript SDK

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:3000/v1',
  apiKey: '<runtime-api-key>',
});

const completion = await client.chat.completions.create({
  model: 'sonnet',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

## curl smoke tests

```bash
curl http://127.0.0.1:3000/healthz

curl http://127.0.0.1:3000/v1/models \
  -H 'Authorization: Bearer <runtime-api-key>'

curl http://127.0.0.1:3000/v1/messages \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <runtime-api-key>' \
  -d '{"model":"sonnet","max_tokens":128,"reasoning_effort":"medium","messages":[{"role":"user","content":"Hello"}]}'

curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <runtime-api-key>' \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Hello"}]}'
```

If `/v1/models` does not contain the alias you want, open **Models** in Admin, refresh discovery, bind the alias to an available backend model, enable it, and save.

## Common environment variables

```bash
CHATGPT_BACKEND=session
CHATGPT_BASE_URL=https://chatgpt.com
CHATGPT_REQUEST_TIMEOUT_MS=60000
CHATGPT_RESPONSE_HEADER_TIMEOUT_MS=60000
CHATGPT_STREAM_BOOTSTRAP_TIMEOUT_MS=60000
CHATGPT_STREAM_IDLE_TIMEOUT_MS=300000
CHATGPT_STREAM_TOTAL_TIMEOUT_MS=0
SSE_KEEPALIVE_INTERVAL_MS=15000
ACCESS_LOG_FORMAT=text
ACCOUNT_ACQUIRE_TIMEOUT_MS=30000
PORT=3000
HOST=127.0.0.1
API_KEYS=<admin-or-runtime-key>
DATA_DIR=./data
```

`CHATGPT_BASE_URL` is the upstream ChatGPT/Codex URL. It is not the client Base URL for Claude Code.

## Persistence and secret handling

The default data directory is `apps/api/data`; override it with `DATA_DIR`. Runtime state stores account sessions, Runtime API Keys, and alias overlays. Operational state stores sanitized admin statistics, discovery/cache data, quota cache, and diagnostics.

To encrypt runtime state, set `STATE_ENCRYPTION_KEY`. It must be strict standard base64 for exactly 32 random bytes:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Never commit OAuth tokens, cookies, Runtime API Keys, Admin API Keys, `STATE_ENCRYPTION_KEY`, local runtime state, proxy credentials, or `.env` files.

## Optional outbound proxy

```bash
OUTBOUND_PROXY_URL=http://127.0.0.1:7890
```

Only HTTP/HTTPS proxy URLs are accepted. SOCKS URLs, paths, queries, and fragments are rejected. The proxy is injected only into ChatGPT/Codex outbound fetches such as completions/SSE, discovery, OAuth exchange/refresh, health checks, quotas, and reset-credit calls. It does not set a global dispatcher and does not proxy local Hono requests or OAuth loopback callbacks.

## Logging and stream timing

Access logging is installed only for `/v1/*` and `/admin/api/*`. The default `ACCESS_LOG_FORMAT=text` prints a request-start line and a response-ready line. For SSE, text logs avoid lifecycle spam and print one real terminal state after stream cleanup:

- `STREAM DONE`
- `STREAM CANCELLED`
- `STREAM FAILED`

`detailed` and `json` formats keep more structured lifecycle metadata for debugging. Log fields are allowlisted and do not contain prompts, tool arguments/results, raw provider payloads, headers, tokens, cookies, session secrets, proxy credentials, or complete query values.

## Verification commands

```bash
corepack pnpm test
corepack pnpm build
corepack pnpm typecheck
```

Or run the full check:

```bash
corepack pnpm check
```

## Documentation

- [中文 README](README.md)
- [English usage guide](docs/USAGE.en.md)
- [中文使用指南](docs/USAGE.zh-CN.md)
- [Protocol compatibility](docs/protocol-compatibility.md)

## Technology stack

- pnpm workspace monorepo
- TypeScript strict mode
- Hono HTTP API
- Vitest
- Node.js runtime
