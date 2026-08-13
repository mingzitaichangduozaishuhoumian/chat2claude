# chatgpt-to-claude

`chatgpt-to-claude` 是一个 TypeScript + Hono 的 Claude Messages API 兼容层骨架，目标是在上层暴露 Claude-like `/v1/messages`、`/v1/models` 等接口，并在后续阶段接入 ChatGPT 后端。

当前 Stage 0/Stage 1 只实现基础 monorepo、协议包、mock backend、runtime 管理后台与最小可运行 API，不接真实 ChatGPT 登录。

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

一键启动脚本会自动启用 corepack；如果还没有 `node_modules`，会先安装依赖。启动脚本不会默认设置 `API_KEYS`，未授权时 `/v1/*` 会返回 401；请在 `/admin` 页面开发授权后再调用 API。当前项目仍使用 mock backend，不接真实 ChatGPT，ChatGPT 授权区域只是后续真实账号池入口占位。

也可以手动运行：

```bash
corepack pnpm setup
corepack pnpm check
corepack pnpm start
```

服务默认监听 `http://localhost:3000`。

## API

- `GET /healthz`：健康检查
- `GET /admin`：原生 JS runtime 管理后台骨架，显示授权状态、账号池、模型映射、curl 示例与 ChatGPT 授权占位
- `GET /admin/api/setup/status`：查看 API key、默认 effort/speed、mock backend 状态
- `POST /admin/api/api-keys/dev-enable`：开发阶段在运行时启用临时 key `sk-test`（进程内有效，重启后失效）
- `GET /admin/api/accounts` / `POST /admin/api/accounts`：列出或添加运行时 mock 账号
- `PATCH /admin/api/accounts/:id`：更新账号 `label/status/enabled/maxConcurrency/currentConcurrency/lastError/capabilities`
- `POST /admin/api/accounts/:id/health-check`：执行 mock 健康检查，刷新 `lastUsedAt`、清空 `lastError`
- `GET /admin/api/models`：列出 runtime 模型注册表
- `PATCH /admin/api/models/:id`：更新模型映射、启用状态与默认 `reasoning_effort` / `speed`
- `POST /admin/api/models/reset`：重置模型注册表为默认 `haiku` / `sonnet` / `opus`
- `GET /v1/models`：返回已启用的 mock Claude alias 模型列表
- `POST /v1/messages`：Claude-like Messages API
  - `stream: false`：返回完整 message
  - `stream: true`：返回基础 Claude SSE 事件流

`/v1/*` 请求需要携带已配置或运行时启用的 API key：

- `x-api-key: <key>`；或
- `Authorization: Bearer <key>`

未设置 `API_KEYS` 且尚未通过 `/admin` 开发授权时，`/v1/*` 会返回 401 并提示去 `/admin` 初始化。

## 示例

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/admin/api/setup/status

curl -X POST http://localhost:3000/admin/api/api-keys/dev-enable

curl http://localhost:3000/v1/models \
  -H 'x-api-key: sk-test'

curl http://localhost:3000/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: sk-test' \
  -d '{"model":"sonnet","max_tokens":128,"reasoning_effort":"medium","response_speed":"balanced","messages":[{"role":"user","content":"你好"}]}'

curl -X PATCH http://localhost:3000/admin/api/models/sonnet \
  -H 'content-type: application/json' \
  -d '{"defaults":{"reasoning_effort":"max","speed":"quality"}}'

curl -X POST http://localhost:3000/admin/api/accounts \
  -H 'content-type: application/json' \
  -d '{"label":"Mock 2","maxConcurrency":2,"capabilities":["mock","messages"]}'
```

## Runtime 管理骨架

### 模型注册表

默认提供 3 个 Claude alias：

| Alias | claudeModel | backendModel | 默认 effort/speed |
| --- | --- | --- | --- |
| `haiku` | `claude-3-5-haiku-latest` | `gpt-4o-mini` | `low` / `fast` |
| `sonnet` | `claude-3-5-sonnet-latest` | `gpt-4o` | `medium` / `balanced` |
| `opus` | `claude-3-opus-latest` | `gpt-4.1` | `high` / `quality` |

`/v1/messages` 会按 `request.model` 读取对应模型 defaults；请求显式传入 `output_config.effort`、`reasoning_effort`、`speed` 或 `response_speed` 时仍优先使用请求值。

### 账号池

账号字段包含：`id`、`label`、`status`、`enabled`、`maxConcurrency`、`currentConcurrency`、`lastUsedAt`、`lastError`、`capabilities`、`createdAt`。当前只做进程内 mock runtime 管理，重启后恢复默认状态。
