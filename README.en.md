# chatgpt-to-claude

[中文](README.md) | **English**

Latest release: **0.2.1** · [Download](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/releases/latest) · [Install and upgrade](INSTALL.md) · [Changelog](CHANGELOG.md)

[![CI](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/actions/workflows/ci.yml)

This README describes `main`. Collapsible model groups, image-alias validation, and source build caching are merged into `main` but are not included in the v0.2.1 archives; see [Unreleased changes](CHANGELOG.md#unreleased). Use the source setup below for these changes. Published archives already require no compilation.

`chatgpt-to-claude` is a TypeScript + Hono local compatibility layer. It exposes Claude Messages, OpenAI Chat Completions, OpenAI Responses, Images, Models API, and related compatibility routes while connecting internally to either a mock backend or a real ChatGPT/Codex session backend.

This project is intended for personal local/private use with ChatGPT/Codex accounts that you own or are explicitly authorized to operate. It is **not** a subscription resale service, public proxy, multi-tenant gateway, or traffic aggregation business. Do not resell personal subscription traffic or expose it to untrusted third parties at scale.

## Download and install

| Package | Intended use |
| --- | --- |
| [Windows x64 portable ZIP](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/releases/download/v0.2.1/chat2claude-v0.2.1-windows-x64.zip) | Includes Node.js. Extract and run `start.bat`. |
| [Universal Node ZIP](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/releases/download/v0.2.1/chat2claude-v0.2.1-node.zip) | Windows, Linux or macOS with a supported Node.js installation. |
| [Universal Node TAR.GZ](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/releases/download/v0.2.1/chat2claude-v0.2.1-node.tar.gz) | Linux/macOS: extract and run `sh start.sh`. |

Packages include the compiled service and production dependencies; no pnpm or build step is needed. Open `http://127.0.0.1:3000/admin` after startup and authorize your account. Node.js 24 LTS is recommended for the universal packages. GitHub's **Source code** downloads require the source setup below.

[SHA-256 checksums](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/releases/download/v0.2.1/SHA256SUMS) · [Configuration, migration and upgrades](INSTALL.md) · [Discussions](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/discussions) · [Report an issue](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/issues/new/choose)

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
- **Client-friendly surface**: one local service exposes Claude Messages, OpenAI Chat Completions, OpenAI Responses, Images, and Models API routes for Claude Code, Anthropic SDK, OpenAI SDK, and OpenAI-compatible clients.
- **Lightweight does not mean toy**: the project still keeps OAuth/session maintenance, model aliases, Runtime/Admin key separation, stream-state tracking, request terminal-state accounting, and safe logging boundaries.
- **Clear permission boundaries**: Runtime API Keys are for normal `/v1/*` clients only. Admin API Keys / configured `API_KEYS` are required for account management and global diagnostics; protected Admin APIs reject Runtime Keys.
- **Logs are useful without leaking content**: logs keep timing, stream terminal state, event/byte counts, safe error categories, and diagnostics; they do not record prompts, tool arguments/results, raw provider payloads, Authorization headers, cookies, tokens, or proxy credentials.

In short: it is not trying to pack every proxy feature into one large platform. It adapts a **personal ChatGPT/Codex account session** into a local Claude/OpenAI-compatible API with stable behavior, clear boundaries, and low operational overhead.

## Quick start

These steps start a source checkout. For release archives, see [Download and install](#download-and-install).

Source development requires Node.js 22.x starting at 22.15.0, or Node.js 24 and newer, plus Corepack. The project pins pnpm 9.15.4; Node.js 25 and newer require a separate Corepack installation.

For a first source checkout, clone the repository and enter its directory:

```bash
git clone https://github.com/mingzitaichangduozaishuhoumian/chat2claude.git
cd chat2claude
```

Windows (PowerShell):

```powershell
.\start.bat
```

Git Bash, Linux, or macOS:

```bash
sh ./start.sh
```

Manual setup, verification, and startup:

```bash
corepack pnpm setup
corepack pnpm check
corepack pnpm start
```

`start` builds only on first use, when source, compiler configuration or dependencies change, or when compiled output is missing or modified. Ordinary restarts skip TypeScript compilation and launch a single API service. This also applies to `start.bat` and `start.sh`. Use `corepack pnpm build` to force a rebuild, or `corepack pnpm build --if-needed` to check and prepare the build without starting the service. Use `corepack pnpm dev` for an initial build followed by API source watching.

The first build's `Scope: 5 of 6 workspace projects` refers to compiling five internal packages, not starting five services. `check` runs the full build, tests, and type checks; it is not required before ordinary startup.

Default address:

```text
http://127.0.0.1:3000
```

Open the Admin console:

```text
http://127.0.0.1:3000/admin
```

`start.bat` / `start.sh` default to the `session` backend. Running `corepack pnpm start` directly without `CHATGPT_BACKEND` uses `mock`. For ChatGPT/Codex session use, complete account authorization, model discovery, and Runtime API Key creation in `/admin`.

### Updating a source checkout

Stop the old process with Ctrl+C in its terminal. Keep `apps/api/data/` (or your custom `DATA_DIR`), existing environment settings, and encryption key. In the project directory, run:

```bash
git pull --ff-only
corepack pnpm install --frozen-lockfile
```

Then run `start.bat` or `sh ./start.sh` with your existing port settings. The launcher checks whether rebuilding is necessary. For release archives, follow [Install and upgrade](INSTALL.md).

### Custom port and host

The default port is `3000`. If it is already in use, or if you want to run multiple instances, set `PORT`.

Git Bash, Linux, or macOS:

```bash
PORT=3100 sh ./start.sh
```

PowerShell:

```powershell
$env:PORT = "3100"
.\start.bat
```

CMD:

```bat
set "PORT=3100"
start.bat
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
2. **Accounts & Authorization**: Codex OAuth, account health/model checks, reauthorization, enable/disable, editing and deletion. Text and image models have separate counts and collapsed groups; expanding a group shows compact model-ID labels.
3. **Models**: text alias selection, enablement, and saving appear first. The image catalog, built-in alias help, and API guidance are collapsed by default. Professional mode adds reasoning, service tiers, and custom aliases.
4. **API Access**: create, name, copy, list, and revoke Runtime API Keys; view Base URL, endpoint, and dynamic curl examples.
5. **Quotas**: read cached provider allowance information and refresh one account or all accounts, distinguishing fresh, stale, error, and unknown states.
6. **Admin Access**: prefer the local HttpOnly admin session; Professional mode exposes an Admin API Key fallback after you independently make the service reachable.

The console opens in Simple mode. Both modes can expand text and image catalogs. Professional mode adds collapsible **Account diagnostics** and **Context window details**, reasoning/service-tier controls, custom aliases, manual session import, and Admin API Key fallback. Diagnostics and lengthy guidance expand on demand; the Images endpoint appears once per group.

### Text and image models

| Type | API and mapping | Parameters |
| --- | --- | --- |
| Text/code models | Call Messages, Chat Completions, or Responses with an alias or text model ID | Reasoning and service tiers depend on catalog capabilities. Displayed context metadata does not describe the client's current settings. |
| Image generation models | Call `POST /v1/images/generations` directly with an image model ID; no text alias is needed | Use image parameters such as `prompt`, `size`, and `quality`. Text reasoning, service-tier, and context-setting fields are not accepted. |

A chat model that accepts image input is not necessarily an image generation model. Admin rejects registered image IDs as new text aliases or text backend targets before saving. Legacy incorrect bindings can still be disabled, cleared, corrected, or deleted.

Ultra (proactive collaboration) resolves a base reasoning effort from the model catalog and encourages the client's existing delegation tools. The client runs subagents; without delegation tools, the main model handles the task directly. This service does not create subagents or implement the complete Codex multi-agent runtime. See [Reasoning efforts and Ultra proactive collaboration](docs/USAGE.en.md#reasoning-efforts-and-ultra-proactive-collaboration).

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

### Independent Images API

`POST /v1/images/generations` reuses an existing ChatGPT account through the Codex 0.160 Images service, defaulting to `gpt-image-2`. On 2026-10-04, all five built-ins each passed one `quality:low`, `n:1` check on one account: HTTP 200, final SSE completion and PNG decoding, taking approximately 13.4–15.5 seconds each. A requested `1024x1024` produced `1254×1254` PNGs in every case; this does not guarantee exact dimensions, access for every account or higher-quality settings. Reuse the OpenAI SDK `client` above:

```ts
const image = await client.images.generate({
  model: 'gpt-image-2', prompt: 'A simple blue circle on a white background',
  size: '1024x1024', quality: 'low', n: 1,
});
// Decode image.data[0].b64_json to obtain a PNG.
```

The endpoint returns JSON/base64 PNG and accepts `n=1..10`. `stream:true` supports only `n=1` and emits one `image_generation.completed` event after the upstream JSON result. There are no partial previews: omit `partial_images` or set it to 0. The separate `CHATGPT_IMAGE_REQUEST_TIMEOUT_MS` defaults to 300000 ms. Image limits are 16 MiB per item, 64 MiB per bundle and 10 images; text and hidden replay limits are unchanged.

The `/v1/models` descriptors with `source: "image_endpoint"` point to this separate route. Sending a registered image model or an alias bound to it to a text endpoint returns 400. Responses image-event conversion supports previews/final images when upstream provides them; real image-tool execution on the current Responses host remains unverified. Responses containing generated images are not stored, and their IDs cannot be continued with `previous_response_id`. Chat/Claude explicitly reject image output with 501 instead of empty success. See the [usage guide](docs/USAGE.en.md#independent-gpt-image-generation) for parameters, decoding and limitations.

Admin account cards count text models and image endpoint models separately, for example 10 text models and 5 image endpoint models. The image count covers the entries currently exposed by this service, not every OpenAI image model. The Models page has a separate, initially collapsed image-model group in both Simple and Professional modes. Built-ins are `gpt-image-1.5`, `gpt-image-2`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` and `gpt-image-2.5`, matching [CPA registration](https://github.com/router-for-me/CLIProxyAPI/blob/8ef43e4df3b216a42493105d31c2873b69191473/internal/registry/model_definitions.go#L245). Bare `gpt-image-2.5` is forwarded unchanged, not renamed to Flare/Sunburst. The documented 2.5 IDs also accept `xhigh`/`max` quality; see the usage guide for the exact set. These entries come from `imageModels`, not text `discoveredModels` or alias choices, and do not claim verified image-generation permission for the account.

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
CHATGPT_IMAGE_REQUEST_TIMEOUT_MS=300000
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

The model catalog can depend on the requested client version. If discovery succeeds but omits new models, update the service and check `clientVersion` in the Professional-mode discovery diagnostics. The current compatibility baseline is `0.160.0`; `CODEX_CLIENT_VERSION` explicitly overrides it, including an older environment value retained after an update. Restart the service and refresh account models after changing the version.

## Persistence and secret handling

The source launch commands above default to `apps/api/data/`; release archives default to `data/` inside the extracted package. Override this with `DATA_DIR`. Relative paths resolve from the API workspace for source startup and from the package root for release startup. Runtime state stores account sessions, Runtime API Keys, and alias overlays. Operational state stores sanitized admin statistics, discovery/cache data, quota cache, and diagnostics.

Source startup reads process environment variables. Release launchers also load the package-root `.env`, with existing environment variables taking precedence. Keep the original data directory and `STATE_ENCRYPTION_KEY` when migrating; see [Install and upgrade](INSTALL.md).

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

After dependency updates, run `corepack pnpm audit` to check the lockfile against known security advisories. `test` runs the Vitest 4 / Vite 6 suite and native Node.js build-cache tests.

GitHub Actions is enabled. See [CI status](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/actions/workflows/ci.yml) and [packaging runs](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/actions/workflows/release.yml):

- Pushes to `main`, pull requests, and manual CI runs check Windows/Linux × Node.js 22.15.0/24. Linux Node 24 also runs the dependency audit, package build, and extracted-package smoke tests.
- Before releasing, update all six `package.json` versions and `CHANGELOG.md`. A matching `v*` version tag triggers publication after Linux build verification and Windows bundled-runtime checks on the same artifacts. Existing assets with the same names are never overwritten.
- Manually running **Release packages** only builds and verifies archives. Outputs remain in Actions artifacts; no Release is created or updated.

Commit changes before building release archives:

```bash
corepack pnpm package:release
corepack pnpm package:smoke
```

Outputs go to `dist-release/`. Building requires Git, development dependencies installed from the lockfile, and network access to download the official Node.js runtime. Browser verification requires Chrome or Edge; override its location with `PACKAGE_SMOKE_BROWSER_PATH`. Packaging rebuilds an isolated source snapshot and rejects a dirty checkout by default. `--allow-dirty` is for preflight checks only; do not publish those marked artifacts.

## Documentation

- [Packages, configuration and upgrades](INSTALL.md)
- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Security reporting](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md)
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

## License

MIT. See [LICENSE](LICENSE).
