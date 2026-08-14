# chatgpt-to-claude

`chatgpt-to-claude` 是一个 TypeScript + Hono 的 Claude Messages API 兼容层骨架，目标是在上层暴露 Claude-like `/v1/messages`、`/v1/models` 等接口，并在后续阶段接入 ChatGPT 后端。

当前默认仍使用 mock backend，保证本地开发不依赖真实 ChatGPT 登录。`CHATGPT_BACKEND=session` 可启用第一批 alpha 版真实 ChatGPT session backend，通过管理后台手动导入 accessToken/cookie 后转发 `/v1/messages`。

## 技术栈

- pnpm workspace monorepo
- TypeScript strict mode
- Hono HTTP API
- Vitest 单元测试
- Docker / docker-compose 基础运行配置

## 快速开始

最简单方式：

### Windows

双击 `start.bat`，或在项目根目录运行：

```bat
start.bat
```

### Git Bash / Linux / Mac

```bash
./start.sh
```

启动后打开初始化页面：

```text
http://localhost:3000/admin
```

也可以访问健康检查：

```text
http://localhost:3000/healthz
```

一键启动脚本会自动启用 corepack；如果还没有 `node_modules`，会先安装依赖。启动脚本不会默认设置 `API_KEYS`，未授权时 `/v1/*` 会返回 401；请在 `/admin` 页面开发授权后再调用 API。默认 `CHATGPT_BACKEND=mock`，mock 阶段启动脚本会为 discovery 配置占位后端模型 `backend-test-model`；也可以用 `MOCK_BACKEND_MODELS_JSON` 覆盖。真实 ChatGPT session backend 仍是 alpha，需要手动导入 accessToken/cookie，不会自动登录或持久化账号。

也可以手动运行：

```bash
corepack pnpm setup
corepack pnpm check
corepack pnpm start
```

服务默认监听 `http://localhost:3000`。

## API

- `GET /healthz`：健康检查
- `GET /admin`：原生 JS runtime 管理后台骨架，显示授权状态、账号池、ChatGPT session 导入表单、模型映射与 curl 示例
- `GET /admin/api/setup/status`：查看 API key、默认 effort/speed、backend provider 状态
- `POST /admin/api/api-keys/dev-enable`：开发阶段生成随机临时 key 并返回给前端（进程内有效，重启后失效）；`NODE_ENV=production` 时返回 403，不允许启用开发 key
- `GET /admin/api/accounts` / `POST /admin/api/accounts`：列出或添加运行时账号；列表只返回 `hasSecret`，不会泄露 `secret`
- `PATCH /admin/api/accounts/:id`：更新账号 `label/status/enabled/maxConcurrency/currentConcurrency/lastError/capabilities`
- `POST /admin/api/accounts/:id/health-check`：执行 mock 健康检查，刷新 `lastUsedAt`、清空 `lastError`
- `GET /admin/api/models`：列出 alias overlay、backend discovery 与合并后的 runtime 模型视图
- `PATCH /admin/api/models/:id`：更新 alias 的 backendModel 映射、启用状态与默认 `reasoning_effort` / `speed`
- `POST /admin/api/models/reset`：重置 alias overlay 为当前配置源默认值（`config/models.json` 或 `MODEL_REGISTRY_JSON`）
- `POST /admin/api/models/refresh`：重新从 backend discovery 获取可用后端模型
- `GET /v1/models`：返回已启用且可解析的 alias 与 discovery passthrough 模型列表
- `POST /v1/messages`：Claude-like Messages API
  - `stream: false`：返回完整 message
  - `stream: true`：返回基础 Claude SSE 事件流

`/v1/*` 请求需要携带已配置或运行时启用的 API key：

- `x-api-key: <key>`；或
- `Authorization: Bearer <key>`

未设置 `API_KEYS` 且尚未通过 `/admin` 开发授权时，`/v1/*` 会返回 401 并提示去 `/admin` 初始化。开发授权不会使用固定 key；请复制 `/admin` 页面或 `dev-enable` 响应 JSON 返回的 `key`。

## 示例

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/admin/api/setup/status

curl -X POST http://localhost:3000/admin/api/api-keys/dev-enable
# 返回 JSON 中的 key 字段，例如：{"key":"sk-dev-..."}

curl http://localhost:3000/v1/models \
  -H 'x-api-key: <your-api-key>'

curl http://localhost:3000/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: <your-api-key>' \
  -d '{"model":"sonnet","max_tokens":128,"reasoning_effort":"medium","response_speed":"balanced","messages":[{"role":"user","content":"你好"}]}'

# passthrough：直接请求 backend discovery 返回的模型 ID
curl http://localhost:3000/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: <your-api-key>' \
  -d '{"model":"<backend-model-id-from-discovery>","max_tokens":128,"messages":[{"role":"user","content":"你好"}]}'

curl -X PATCH http://localhost:3000/admin/api/models/sonnet \
  -H 'content-type: application/json' \
  -d '{"backendModel":"<backend-model-id-from-discovery>","defaults":{"reasoning_effort":"max","speed":"quality"}}'

curl -X POST http://localhost:3000/admin/api/accounts \
  -H 'content-type: application/json' \
  -d '{"provider":"mock","label":"Mock 2","maxConcurrency":2,"capabilities":["mock","messages"]}'

# alpha：启用 CHATGPT_BACKEND=session 后，手动导入 ChatGPT session
curl -X POST http://localhost:3000/admin/api/accounts \
  -H 'content-type: application/json' \
  -d '{"provider":"chatgpt-session","label":"Session 1","capabilities":["chatgpt-session","messages"],"secret":{"type":"chatgpt-session","accessToken":"<access-token>","cookie":"<cookie>","deviceId":"<device-id>","userAgent":"<user-agent>"}}'
```

## Runtime 管理骨架

### 模型 discovery 与 alias overlay

后端模型不是源码或 `config/models.json` 里的静态模型表。启动时 API 会创建 backend client，并通过 `backend.listModels(context?)` 获取可用模型；mock 阶段可通过 `MOCK_BACKEND_MODELS_JSON` 配置 discovery。session backend 在无账号上下文的启动 discovery 会返回空数组；导入 `chatgpt-session` 账号后，健康检查或 `/admin/api/models/refresh` 会用第一个可用 session 账号请求 `/backend-api/codex/models` 刷新 discovery。

```bash
export MOCK_BACKEND_MODELS_JSON='[{"id":"backend-test-model","displayName":"Backend Test Model"}]'
```

alias overlay 启动时从外部配置源读取：

1. 如果设置了 `MODEL_REGISTRY_JSON`，优先解析该环境变量中的 JSON；
2. 否则读取根目录 `config/models.json`。

`config/models.json` 只管理 alias 映射，不是真实后端模型表。配置格式为 `{ "aliases": [...] }`，每个 alias 至少包含 `id`；可选字段包括 `display_name`、`backendModel`、`enabled`、`defaults.reasoning_effort`、`defaults.speed` 与 `capabilities`。`backendModel` 可以为空，表示该 alias 暂未绑定。管理后台的 reset 会恢复 alias overlay，`/admin/api/models/refresh` 会重新拉取 backend discovery。

`/v1/messages` 解析规则：enabled alias 绑定到 discovery 中存在的 `backendModel` 时转发到该后端模型；直接请求 discovery 中的模型 ID 时 passthrough；未绑定 alias、过期绑定和未知模型都会返回清晰错误。请求显式传入 `output_config.effort`、`reasoning_effort`、`speed` 或 `response_speed` 时仍优先使用请求值。

### 账号池

账号字段包含：`id`、`label`、`provider`、`status`、`enabled`、`maxConcurrency`、`currentConcurrency`、`lastUsedAt`、`lastError`、`capabilities`、`hasSecret`、`createdAt`。内部账号可携带 `secret` 供 backend 使用，但 admin list/add/update 响应会脱敏，只暴露 `hasSecret`。当前只做进程内 runtime 管理，重启后恢复默认状态。

### Backend 配置

默认配置保持 mock：

```bash
CHATGPT_BACKEND=mock
CHATGPT_BASE_URL=https://chatgpt.com
CHATGPT_REQUEST_TIMEOUT_MS=60000
```

设置 `CHATGPT_BACKEND=session` 后，`SessionChatGptBackend` 会使用导入账号的 `secret.accessToken`/`cookie` 请求 `CHATGPT_BASE_URL/backend-api/codex/responses`，以 SSE 聚合或流式返回文本。该能力仍是 alpha：不会自动登录、不持久化 secret、不硬编码真实模型表，建议仅在本地手动导入会话后试用。

session alpha 推荐使用顺序：

1. 启动时设置 `CHATGPT_BACKEND=session`，打开 `/admin`。
2. 在账号池导入 `provider=chatgpt-session` 的账号 secret。
3. 对该账号执行 health-check，或调用 `/admin/api/models/refresh`，触发账号上下文下的模型 discovery。
4. 在模型映射里把 `sonnet`/`haiku` 等 alias 绑定到 discovery 返回的 backend model。
5. 调用 `/v1/messages`；session 模式只会 acquire `chatgpt-session` 账号，不会使用默认 `mock-account`。
