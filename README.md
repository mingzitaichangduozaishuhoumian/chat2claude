# chatgpt-to-claude

`chatgpt-to-claude` 是一个 TypeScript + Hono 的 Claude Messages API 兼容层，向上暴露 Claude-like `/v1/messages`、`/v1/models`，向下可接入 mock backend 或真实 ChatGPT session backend。

普通用户路径已经改为“一键授权 ChatGPT”：打开 `/admin` 后点击“授权 ChatGPT”，服务会尝试打开独立 Chrome profile 登录页，并通过本机 127.0.0.1 Chrome DevTools Protocol 自动检测 session；成功后自动创建 `chatgpt-primary` 账号、执行 health-check、刷新模型、绑定 `sonnet` alias、生成 runtime API key，并在页面展示 endpoint/key/curl。手动 accessToken/cookie 导入仍保留在高级区域作为 fallback。

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

点击页面主按钮“授权 ChatGPT”，完成登录后复制页面显示的 endpoint、API key 和 curl 示例即可调用 `/v1/messages`。

一键启动脚本会自动启用 corepack；如果还没有 `node_modules`，会先安装依赖。面向普通用户的 `start.bat` / `start.sh` 在未设置 `CHATGPT_BACKEND` 时默认使用 `session`，并提示打开 `/admin` 授权。代码层 `loadEnv()` 默认仍保持 `mock`，用于保护测试与本地开发。

也可以手动运行：

```bash
corepack pnpm setup
corepack pnpm check
corepack pnpm start
```

服务默认监听 `http://localhost:3000`，健康检查为 `http://localhost:3000/healthz`。

## 一键授权流程

1. `POST /admin/api/auth/chatgpt/start` 创建授权 flow，尝试启动 Chrome 并打开 `https://chatgpt.com/`。如果未找到 Chrome 或 CDP 不可用，仍返回登录链接，并提示使用高级手动导入兜底。
2. 前端轮询 `GET /admin/api/auth/chatgpt/:id`。服务会通过 CDP 在 ChatGPT 页面执行 `fetch('/api/auth/session', { credentials: 'include' })` 检测 `accessToken`，并读取 cookie header。
3. 拿到 session 后自动 provisioning：
   - upsert 固定账号 `chatgpt-primary`，provider 为 `chatgpt-session`；
   - 调用 backend `healthCheck({ account })`；
   - `modelRegistry.refreshFromBackend(backend, { account })`；
   - 从 discovery 中按关键词优先级选择最佳模型绑定到 `sonnet` alias（`gpt-5`、`codex`、`thinking`、`gpt-4`、第一个）；
   - 生成进程内 runtime API key。
4. 页面只展示脱敏账号信息、API key、base URL 和 curl，不返回 accessToken/cookie。

取消授权：`POST /admin/api/auth/chatgpt/:id/cancel`。服务只会尽量关闭自己启动的 Chrome 进程，不会强杀用户已有浏览器。

## 高级手动导入 fallback

自动检测失败时，在 `/admin` 展开“高级：手动导入 accessToken / cookie”，填入 session 后会走同一套 provisioning。

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
- `POST /admin/api/auth/chatgpt/start`：开始 ChatGPT 一键授权
- `GET /admin/api/auth/chatgpt/:id`：轮询授权；拿到 secret 后自动 provisioning（只执行一次）
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

`/v1/*` 请求需要携带已配置或运行时启用的 API key：

- `x-api-key: <key>`；或
- `Authorization: Bearer <key>`

未设置 `API_KEYS` 且尚未通过 `/admin` 授权生成 runtime key 时，`/v1/*` 会返回 401 并提示去 `/admin` 初始化。

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
