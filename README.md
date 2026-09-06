# chatgpt-to-claude

`chatgpt-to-claude` 是一个 TypeScript + Hono 的个人自托管、local-first 开源 Claude/OpenAI 兼容层，向上暴露 Claude-like `/v1/messages`、OpenAI-compatible `/v1/chat/completions`、`/v1/responses` 和 `/v1/models`，向下可接入 mock backend 或真实 ChatGPT session backend。

本项目面向使用本人控制或已获明确授权的 ChatGPT/Codex 账号及其包含用量的个人自托管场景。不得将个人订阅流量公开转售、向不特定第三方重新提供或进行大规模共享；它不是订阅聚合、流量转售或多租户共享网关。

普通用户路径是“浏览器授权（Codex OAuth）”：打开 `/admin` 后点击主按钮，页面会立即预开一个新标签页，再生成 OpenAI Codex OAuth PKCE 授权链接并导航到授权页。服务不会启动独立 Chrome/新 profile，也不再依赖已登录 `chatgpt.com` 页面抓 token。成功后自动创建 `chatgpt-primary` 账号、执行 health-check、刷新模型、绑定 `sonnet` alias、生成幂等的持久化 runtime API key，并在页面展示 endpoint/key/curl。若弹窗被拦截，仍可点击普通授权链接或复制完整 URL；手动 accessToken/cookie 导入保留在高级区域作为 fallback。

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

本机打开 `/admin` 会自动建立仅当前进程有效的 HttpOnly 浏览器管理会话，无需先设置临时 `API_KEYS`，即使重启后浏览器没有保存 Runtime API Key 也可继续管理账号。点击页面主按钮“打开 Codex OAuth 授权页”会直接打开新标签页；若浏览器拦截弹窗，可点击保留的普通链接或复制完整授权 URL。授权完成后，新标签页会回到同一 Admin flow 并继续自动初始化；随后立即复制页面一次性显示的 Runtime API Key、endpoint 和 curl 示例即可调用 `/v1/messages`。

一键启动脚本会自动启用 corepack；如果还没有 `node_modules`，会先安装依赖。面向普通用户的 `start.bat` / `start.sh` 在未设置 `CHATGPT_BACKEND` 时默认使用 `session`，并提示打开 `/admin` 授权。代码层 `loadEnv()` 默认仍保持 `mock`，用于保护测试与本地开发。

生产默认 `config/models.json` 定义四个内置 alias：`haiku`、`sonnet`、`fable`、`opus`，包含能力与默认 effort/speed，但不预绑定任何生产 backend model。`/v1/models` 只返回已经解析成功的 alias 与 backend discovery passthrough 模型。完成 OAuth/手动 session provisioning 后，服务会从 discovery 自动选择最佳后端；服务重启后的 discovery refresh 则只在 `sonnet` 尚未绑定时自动选择，已持久化或手动选择的 `sonnet.backendModel` 不会被覆盖。测试如需固定 `sonnet -> backend-test-model`，通过测试 fixture/env 显式注入 alias overlay。

使用本项目直接配置 Claude Code（包括 Runtime API Key、模型别名和常见错误处理）请参阅[中文使用指南](docs/USAGE.zh-CN.md)。

也可以手动运行：

```bash
corepack pnpm setup
corepack pnpm check
corepack pnpm start
```

服务默认只监听本机 `127.0.0.1`（`http://localhost:3000`），健康检查为 `http://localhost:3000/healthz`。非 loopback `HOST` 在没有预配置 `API_KEYS` 时会拒绝启动，避免匿名 bootstrap 暴露到局域网/公网。`LOCAL_CONTAINER_BOOTSTRAP=true` 只供 `docker-compose.yml` 的容器内 `0.0.0.0` 监听使用；compose 将宿主端口固定发布为 `127.0.0.1:3000:3000`，不得把该开关当作公网部署默认值。

## 一键授权流程

1. `POST /admin/api/auth/chatgpt/start` 创建授权 flow，使用密码学随机 flow ID、一次性 OAuth `state`、PKCE `code_verifier` / `code_challenge`，返回 `https://auth.openai.com/oauth/authorize` 授权链接。当前 scope 为 `openid profile email offline_access api.connectors.read api.connectors.invoke`，并诚实标记 `originator=chat2claude`。Admin 点击处理器会在任何网络等待前同步 `window.open('about:blank', '_blank')`，start 成功后导航并聚焦该标签；服务端本身不会启动独立 Chrome/新 profile。
2. `POST /admin/api/auth/chatgpt/start` 接收页面提交的精确 `adminOrigin`。服务将它与实际请求的 Host 和 `Origin` 严格比对，只接受不含 path、query、hash、userinfo 的完整 HTTP(S) origin；通过后仅在服务端 flow 内关联为安全回跳目标。redirect URI 始终为 `http://localhost:<port>/auth/callback`。listener 会在同一端口仅绑定 Windows/Linux 可用的 loopback：优先尝试 `::1`（`ipv6Only`）并同时绑定 `127.0.0.1`；若某个可用地址族的端口已占用，会关闭本轮已打开的 socket，并从 1455 整体切换到已注册的 1457 fallback。系统不支持 IPv6 时可只使用 IPv4，绝不绑定 wildcard 或 LAN 地址。
3. listener 或手动 callback API 收到 code 后会立即以 single-flight 完成 authorization-code exchange，不再等待原 Admin 标签页下一次 status polling 才换 token。成功 listener callback 返回 `303 <origin>/admin?oauth_flow=<flow-id>`；query 只含非敏感高熵 flow locator，不含 code、state、verifier 或 token。未关联 origin 时保持静态成功页。所有 listener 响应继续使用 no-store、no-referrer、CSP 和 nosniff 安全头。`POST /admin/api/auth/chatgpt/callback` 支持粘贴完整 `redirectUrl` / `redirect_url`；URL 必须与该 flow 的实际 `http://localhost:<1455|1457>/auth/callback` 完全匹配，错误协议、host、端口、path、userinfo、fragment、重复或冲突参数会被拒绝，state 成功接收后只能消费一次。
4. callback 打开的 Admin 页面会先校验 `oauth_flow` 格式，只把 `{flowId, origin}` 写入 `sessionStorage`，随即用 `history.replaceState` 从地址栏移除 query，再恢复同一 flow 并继续轮询/provisioning。刷新恢复也会校验 origin；完成、取消、过期、错误或 404 时清理，404 会明确提示服务重启或流程过期。绝不会在 URL 或该存储中保存 OAuth code/state/verifier/token/cookie、Admin key 或 Runtime key。authorization-code exchange 与 provisioning 都按 flow single-flight；并发请求不会重复换码、重复创建账号或生成多批 key。换码完成后清理 code/verifier，provisioning 完成后清理 flow secret 副本。`refresh_token` / `id_token` / `expiresAt` 仅保存在进程内账号 secret，不返回给前端、错误或日志。
5. 拿到 OAuth access token 后自动 provisioning：
   - upsert 固定账号 `chatgpt-primary`，provider 为 `chatgpt-session`；
   - 调用 backend `healthCheck({ account })`；
   - `modelRegistry.refreshFromBackend(backend, { account })`；
   - 从 discovery 中按关键词优先级选择最佳模型（`gpt-5`、`codex`、`thinking`、`gpt-4`、第一个）并原子持久化绑定；之后启动恢复中的 discovery refresh 会保留已有手动/持久化绑定；
   - 生成持久化 runtime API key。
6. 页面只展示脱敏账号信息、API key、base URL 和 curl，不返回 accessToken/cookie/id_token/refresh_token。
7. 运行时会在 token 到期前 60 秒主动 refresh，并原子写回 refresh-token rotation。同账号并发 refresh 合并为一次；首次 401 会使用最新凭据最多重试一次。流式请求只有在尚未输出任何事件时才允许 refresh/retry，避免重复内容。

OAuth 凭据、账号池和 runtime key 会持久保存到本机 `DATA_DIR/runtime-state.json`；没有数据库或远端同步。默认 `DATA_DIR` 为 API 应用的 `data` 目录；例如在 `.env` 设置 `DATA_DIR=./custom-data` 可指定其他目录。可选的 `STATE_ENCRYPTION_KEY` 会以 AES-256-GCM 加密状态文件，必须是无空白、严格标准 base64 编码的 32 字节密钥（44 个字符、末尾一个 `=`）；请先用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` 生成，再将完整输出写入 `.env`。Docker Compose 默认挂载命名卷 `runtime-state` 到 `/app/data`，因此容器重启会恢复账号和 runtime key。

取消授权：`POST /admin/api/auth/chatgpt/:id/cancel`。服务只取消当前 OAuth flow；不会启动或关闭用户浏览器。

## 高级手动导入 fallback

OAuth 授权不可用或你已有可用 session secret 时，在 `/admin` 展开“高级：手动导入 accessToken / cookie”，填入 session 后会走同一套 provisioning。主流程不要依赖 `chatgpt.com` 已登录页面抓 token；高级导入只是 fallback。

Docker、远程服务器或浏览器不在运行 chat2claude 的同一台机器时，授权提供方访问的 `localhost` 指向浏览器所在机器，callback 可能无法到达服务容器/远端主机；本修复不声称自动解决这种网络拓扑。此时请从浏览器地址栏复制包含 `code` 和 `state` 的完整 `http://localhost:<port>/auth/callback?...` URL，并粘贴到 Admin 的“提交 callback URL”输入框，由服务端校验后继续 exchange/provisioning。

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
- `POST /admin/api/auth/chatgpt/start`：开始 Codex OAuth PKCE 授权并返回授权链接；Admin 页面会同步预开新标签后导航，API 本身不启动浏览器
- `POST /admin/api/auth/chatgpt/callback`：提交完整 OAuth callback URL，并立即推进 single-flight token exchange
- `GET /admin/api/auth/chatgpt/:id`：恢复/轮询授权；拿到 exchanged secret 后自动 provisioning（只执行一次）
- `POST /admin/api/auth/chatgpt/:id/cancel`：取消授权 flow
- `POST /admin/api/auth/chatgpt/complete`：高级手动导入 session，并走同一套 provisioning
- `POST /admin/api/api-keys/dev-enable`：开发阶段生成随机持久 runtime key；`NODE_ENV=production` 时禁用
- `GET /admin/api/api-keys`：列出脱敏的 runtime key 记录（稳定 ID、可选名称、创建时间和前缀；不返回原始 key）
- `DELETE /admin/api/api-keys/:id`：撤销指定 runtime key；撤销后立即失效，删除最后一个 runtime key 后是否可匿名 bootstrap 仍仅由现有本地监听、无 `API_KEYS` 和无 runtime key 策略决定
- `GET /admin/api/accounts` / `POST /admin/api/accounts`：列出或添加运行时账号；列表只返回 `hasSecret`
- `PATCH /admin/api/accounts/:id`：更新账号元数据
- `DELETE /admin/api/accounts/:id`：删除持久账号；不存在返回 404，有进行中的请求（`currentConcurrency > 0`）返回 409
- `POST /admin/api/accounts/:id/health-check`：执行健康检查；session 账号成功后会刷新模型 discovery
- `GET /admin/api/models`：列出 alias overlay、backend discovery 与合并后的 runtime 模型视图
- `POST /admin/api/models`：创建自定义 alias；创建、更新和删除均会原子持久化
- `PATCH /admin/api/models/:id`：更新 alias 的 backendModel 映射、启用状态与默认 `reasoning_effort` / `speed`
- `DELETE /admin/api/models/:id`：删除自定义 alias（内置 `haiku` / `sonnet` / `fable` / `opus` 不可删除）
- `POST /admin/api/models/reset`：重置 alias overlay 为配置源默认值
- `POST /admin/api/models/refresh`：重新从 backend discovery 获取可用后端模型
- `GET /v1/models`：返回已启用且可解析的 alias 与 discovery passthrough 模型列表
- `POST /v1/messages`：Claude-like Messages API，支持非流式与 SSE 流式

OpenAI Responses 的 `store:true` 仅用于本地短期续接 `previous_response_id`，不会请求 ChatGPT/Codex 上游持久保存。Responses built-in/hosted tools（如 `web_search_preview` / `file_search` / `code_interpreter`）会 best-effort 透传给 session backend；真实支持取决于 ChatGPT/Codex 上游。

`/v1/*` 请求始终需要携带已配置或运行时启用的 API key。浏览器管理会话绝不会被 `/v1/*` 接受。自动化和远程管理继续使用：

- `x-api-key: <key>`；或
- `Authorization: Bearer <key>`

默认 loopback 监听（或明确的 `LOCAL_CONTAINER_BOOTSTRAP=true`）下，访问 `/admin` 会签发仅进程有效的 HttpOnly、`SameSite=Strict` 管理 cookie；cookie 驱动的写操作必须有同源 `Origin`。它只用于个人本机管理，服务重启后自动失效，重新打开 `/admin` 会重新签发。连接到本地会话时，页面不会读取或发送 `localStorage` 中旧的显式 Admin API Key；仅远程访问或本地会话不可用时才会回退到明确输入/保存的 Admin Key。

管理页面默认是简洁模式：保留 OAuth、一次性 Runtime API Key 复制区、Runtime Key 的用途、数量/安全前缀列表和确认撤销入口。专业模式提供账号池和完整 alias/custom alias 管理。Runtime API Key 是客户端访问 `/v1/*` 的凭据；Admin API Key 仅用于远程或自动化管理 `/admin/api/*`，两者不可互换。Runtime API Key 持久化后，原始值不会在 Key 列表或之后的页面加载中重新展示；遗失时请在本地后台撤销旧 Key 后重新授权生成并立即复制。

非 loopback 且未启用 `LOCAL_CONTAINER_BOOTSTRAP=true` 时，服务不会签发或接受此 cookie，并且仍要求显式 `API_KEYS`。未设置 `API_KEYS` 且尚未通过 `/admin` 授权生成 runtime key 时，`/v1/*` 会返回 401 并提示去 `/admin` 初始化。

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

`config/models.json` 只管理 alias 映射，不是真实后端模型表。内置 alias 为 `haiku`、`sonnet`、`fable`、`opus`；其中未绑定的 alias 不可调用，需在专业模式选择 discovery 中的 backend model。`fable` 是可配置内置 alias，不硬编码生产 backend ID。专业模式支持自定义 alias 的创建、更新和删除，所有 alias overlay 变更都会保存到 `DATA_DIR/runtime-state.json` 并在重启后恢复。管理后台的 reset 会恢复 alias overlay，refresh 会重新拉取 backend discovery。

### 个人账号池

多账号池保留给同一自托管操作者管理本人控制或获明确授权的账号，用于故障隔离、冷却、并发控制和本地调度，不用于公开转售或面向不特定第三方的大规模共享。账号字段包含：`id`、`label`、`provider`、`status`、`enabled`、`maxConcurrency`、`currentConcurrency`、`lastUsedAt`、`lastError`、`capabilities`、`hasSecret`、`createdAt`。内部账号可携带 `secret` 供 backend 使用，但 admin list/add/update/provisioning 响应会脱敏，只暴露 `hasSecret`。账号与 runtime key 的可变管理操作会原子持久化，重启后恢复；请求中的临时并发计数不会持久化，并会以 0 恢复。

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
