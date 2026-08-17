# chatgpt-to-claude

`chatgpt-to-claude` 是一个 TypeScript + Hono 的 Claude Messages API 兼容层，向上暴露 Claude-like `/v1/messages`、`/v1/models`，向下可接入 mock backend 或真实 ChatGPT session backend。

普通用户路径已经改为“浏览器授权（Codex OAuth）”：打开 `/admin` 后生成 OpenAI Codex OAuth PKCE 授权链接，服务不会启动独立 Chrome/新 profile，也不再依赖已登录 `chatgpt.com` 页面抓 token。用户在当前浏览器/已登录账号环境中打开链接授权；成功后自动创建 `chatgpt-primary` 账号、执行 health-check、刷新模型、绑定 `sonnet` alias、生成 runtime API key，并在页面展示 endpoint/key/curl。手动 accessToken/cookie 导入仍保留在高级区域作为 fallback。

## 技术栈

- pnpm workspace monorepo
- TypeScript strict mode
- Hono HTTP API
- Vitest 单元测试
- Docker / docker-compose 基础运行配置

## 快速开始

### Windows

双击 `start.bat`，或在项目根目录运行：

```bat
start.bat
```

### Git Bash / Linux / Mac

```bash
./start.sh
```

启动后打开：

```text
http://localhost:3000/admin
```

点击页面主按钮“生成 Codex OAuth 授权链接”，把链接复制或在当前浏览器中打开完成授权；随后复制页面显示的 endpoint、API key 和 curl 示例即可调用 `/v1/messages`。

一键启动脚本会自动启用 corepack；如果还没有 `node_modules`，会先安装依赖。面向普通用户的 `start.bat` / `start.sh` 在未设置 `CHATGPT_BACKEND` 时默认使用 `session`，并提示打开 `/admin` 授权。代码层 `loadEnv()` 默认仍保持 `mock`，用于保护测试与本地开发。

生产默认 `config/models.json` 只定义 `haiku` / `sonnet` / `opus` alias 的能力与默认 effort/speed，不预绑定任何测试 backend model；`/v1/models` 只返回已经解析成功的 alias 与 backend discovery passthrough 模型。完成 OAuth/手动 session provisioning 后，服务会刷新 discovery，并把 `sonnet` 自动绑定到发现到的最佳后端模型。测试如需固定 `sonnet -> backend-test-model`，通过测试 fixture/env 显式注入 alias overlay。

也可以手动运行：

```bash
corepack pnpm setup
corepack pnpm check
corepack pnpm start
```

服务默认只监听本机 `127.0.0.1`（`http://localhost:3000`），健康检查为 `http://localhost:3000/healthz`。如需局域网/公网访问，必须预先设置 `API_KEYS`，并显式设置 `HOST=0.0.0.0`。

## 一键授权流程

1. `POST /admin/api/auth/chatgpt/start` 创建授权 flow，生成 OAuth `state`、PKCE `code_verifier` / `code_challenge`，返回 `https://auth.openai.com/oauth/authorize` 授权链接。服务不会打开浏览器，不会启动独立 Chrome/新 profile。
2. 服务会尽量在 `127.0.0.1:1455` 启动本地 callback listener，接收 `GET /auth/callback?code=&state=...` 并返回中文完成页。如果 1455 端口占用或监听失败，start 仍返回授权链接；授权后浏览器若显示无法连接 `localhost:1455`，把地址栏完整 callback URL 粘贴回后台提交。
3. `POST /admin/api/auth/chatgpt/callback` 支持 `{ "redirectUrl": "http://localhost:1455/auth/callback?..." }` / `{ "redirect_url": ... }` / `{ "code": "...", "state": "..." }`，只记录 OAuth code 和 state，不向前端暴露 token。
4. 前端轮询 `GET /admin/api/auth/chatgpt/:id`。当 flow 已收到 code 且还没有 secret 时，服务调用 `https://auth.openai.com/oauth/token` 使用 `authorization_code` + PKCE `code_verifier` 换取 token，并把 `access_token` 作为兼容的 `chatgpt-session` secret 保存；`refresh_token` / `id_token` / `expiresAt` 仅保存在内部 secret，不返回给前端或日志。
5. 拿到 OAuth access token 后自动 provisioning：
   - upsert 固定账号 `chatgpt-primary`，provider 为 `chatgpt-session`；
   - 调用 backend `healthCheck({ account })`；
   - `modelRegistry.refreshFromBackend(backend, { account })`；
   - 从 discovery 中按关键词优先级选择最佳模型绑定到 `sonnet` alias（`gpt-5`、`codex`、`thinking`、`gpt-4`、第一个）；
   - 生成进程内 runtime API key。
6. 页面只展示脱敏账号信息、API key、base URL 和 curl，不返回 accessToken/cookie/id_token/refresh_token。

取消授权：`POST /admin/api/auth/chatgpt/:id/cancel`。服务只取消当前 OAuth flow；不会启动或关闭用户浏览器。

## 高级手动导入 fallback

OAuth 授权不可用或你已有可用 session secret 时，在 `/admin` 展开“高级：手动导入 accessToken / cookie”，填入 session 后会走同一套 provisioning。主流程不要依赖 `chatgpt.com` 已登录页面抓 token；高级导入只是 fallback。

对应 API：

```bash
curl -X POST http://localhost:3000/admin/api/auth/chatgpt/complete \
  -H 'content-type: application/json' \
  -d '{"accessToken":"<access-token>","cookie":"<cookie>","deviceId":"<device-id>","userAgent":"<user-agent>"}'
```

响应不会泄露 secret，只返回脱敏账号、发现模型、绑定 alias 和 runtime API key。

## API

- `GET /healthz`：健康检查
- `GET /admin`：原生 JS 管理后台，一键授权、API 配置、账号池和模型映射
- `GET /admin/api/setup/status`：查看 API key、默认 effort/speed、backend provider 状态
- `GET /admin/api/auth/status`：查看整体授权 ready 状态
- `POST /admin/api/auth/chatgpt/start`：开始 Codex OAuth PKCE 授权，返回授权链接但不打开浏览器
- `POST /admin/api/auth/chatgpt/callback`：提交 OAuth callback URL 或 `code`/`state`
- `GET /admin/api/auth/chatgpt/:id`：轮询授权；收到 code 后 exchange token，拿到 secret 后自动 provisioning（只执行一次）
- `POST /admin/api/auth/chatgpt/:id/cancel`：取消授权 flow
- `POST /admin/api/auth/chatgpt/complete`：高级手动导入 session，并走同一套 provisioning
- `POST /admin/api/api-keys/dev-enable`：开发阶段生成随机临时 key；`NODE_ENV=production` 时禁用
- `GET /admin/api/accounts` / `POST /admin/api/accounts`：列出或添加运行时账号；列表只返回 `hasSecret`
- `PATCH /admin/api/accounts/:id`：更新账号元数据
- `POST /admin/api/accounts/:id/health-check`：执行健康检查；session 账号成功后会刷新模型 discovery
- `GET /admin/api/models`：列出 alias overlay、backend discovery 与合并后的 runtime 模型视图
- `PATCH /admin/api/models/:id`：更新 alias 的 backendModel 映射、启用状态与默认 `reasoning_effort` / `speed`
- `POST /admin/api/models/reset`：重置 alias overlay 为配置源默认值
- `POST /admin/api/models/refresh`：重新从 backend discovery 获取可用后端模型
- `GET /v1/models`：返回已启用且可解析的 alias 与 discovery passthrough 模型列表
- `POST /v1/messages`：Claude-like Messages API，支持非流式与 SSE 流式

OpenAI Responses 的 `store:true` 仅用于本地短期续接 `previous_response_id`，不会请求 ChatGPT/Codex 上游持久保存。Responses built-in/hosted tools（如 `web_search_preview` / `file_search` / `code_interpreter`）会 best-effort 透传给 session backend；真实支持取决于 ChatGPT/Codex 上游。

`/v1/*` 请求需要携带已配置或运行时启用的 API key。已配置 `API_KEYS` 后，admin API 请求也需要携带同一个 key：

- `x-api-key: <key>`；或
- `Authorization: Bearer <key>`

未设置 `API_KEYS` 且尚未通过 `/admin` 授权生成 runtime key 时，`/v1/*` 会返回 401 并提示去 `/admin` 初始化。

管理后台默认只把 Admin API key 保存到浏览器 `sessionStorage`，关闭当前标签/会话后失效；只有显式勾选“记住到本机”时才会长期保存到 `localStorage`。旧版本已经保存在 `localStorage` 的 key 仍会兼容读取。

## 调用示例

```bash
curl http://localhost:3000/healthz

curl http://localhost:3000/v1/models \
  -H 'x-api-key: <your-api-key>'

curl http://localhost:3000/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: <your-api-key>' \
  -d '{"model":"sonnet","max_tokens":128,"reasoning_effort":"medium","response_speed":"balanced","messages":[{"role":"user","content":"你好"}]}'
```

管理后台里的 curl/base URL 基于 `window.location.origin` 生成，不写死端口。

## Runtime 管理骨架

### 模型 discovery 与 alias overlay

后端模型不是源码或 `config/models.json` 里的静态模型表。启动时 API 会创建 backend client，并通过 `backend.listModels(context?)` 获取可用模型；mock 阶段可通过 `MOCK_BACKEND_MODELS_JSON` 配置 discovery。session backend 在无账号上下文的启动 discovery 会返回空数组；一键授权或高级导入完成后，会用 `chatgpt-primary` 的账号上下文请求 `/backend-api/codex/models` 刷新 discovery。

alias overlay 启动时从外部配置源读取：

1. 如果设置了 `MODEL_REGISTRY_JSON`，优先解析该环境变量中的 JSON；
2. 否则读取根目录 `config/models.json`。

`config/models.json` 只管理 alias 映射，不是真实后端模型表。管理后台的 reset 会恢复 alias overlay，refresh 会重新拉取 backend discovery。

### 账号池

账号字段包含：`id`、`label`、`provider`、`status`、`enabled`、`maxConcurrency`、`currentConcurrency`、`lastUsedAt`、`lastError`、`capabilities`、`hasSecret`、`createdAt`。内部账号可携带 `secret` 供 backend 使用，但 admin list/add/update/provisioning 响应会脱敏，只暴露 `hasSecret`。当前只做进程内 runtime 管理，重启后恢复默认状态。

### Backend 配置

`.env.example` 提供普通用户默认配置：

```bash
CHATGPT_BACKEND=session
CHATGPT_BASE_URL=https://chatgpt.com
CHATGPT_REQUEST_TIMEOUT_MS=60000
```

设置 `CHATGPT_BACKEND=session` 后，`SessionChatGptBackend` 会使用授权账号的 `secret.accessToken`/`cookie` 请求 `CHATGPT_BASE_URL/backend-api/codex/responses`，以 SSE 聚合或流式返回文本。不会硬编码真实模型表，不会把 token/cookie 打到日志或返回给前端。

## 验证

```bash
corepack pnpm test
corepack pnpm build
corepack pnpm typecheck
```
