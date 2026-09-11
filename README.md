# chatgpt-to-claude

**中文** | [English](README.en.md)

`chatgpt-to-claude` 是一个 TypeScript + Hono 实现的本地兼容层：对外提供 Claude Messages、OpenAI Chat Completions、OpenAI Responses、Models API 等接口，对内连接 mock backend 或真实 ChatGPT/Codex session backend。

本项目面向使用本人控制或已获明确授权的 ChatGPT/Codex 账号的个人本地/私有场景。它不是订阅聚合、流量转售、多租户共享网关或公共代理服务；不要把个人订阅流量公开转售，或面向不特定第三方大规模共享。

## 我们的项目不一样在哪里

`chatgpt-to-claude` 的定位很明确：它是一个 **本地轻量的 ChatGPT/Codex 到 Claude/OpenAI 兼容 API 适配器**。它把你本机可控的 ChatGPT/Codex 账号会话整理成 Claude Code、Anthropic SDK、OpenAI SDK 以及 OpenAI 兼容客户端能直接使用的接口。

它不是大型 all-in-one 代理网关，也不追求成为“最大、最全”的代理 hub。它选择的是另一条路线：默认跑在个人电脑或私有环境里，默认监听 `127.0.0.1`，用尽量少的运维负担解决本地开发和个人工具接入问题。

它解决的是这类实际问题：

- 你有自己控制或已获授权的 ChatGPT/Codex 账号，但常用客户端只认识 Claude 或 OpenAI 风格 API。
- 你希望 Claude Code、Anthropic SDK、OpenAI SDK、Continue、Cherry Studio 等客户端共用同一个本地服务。
- 你不想把 OAuth、token、cookie、模型发现、alias 绑定和 Runtime API Key 分散塞进不同工具配置里。
- 你需要一个本机 `/admin` 集中完成授权、模型发现、alias 绑定和 Runtime API Key 创建，而不是维护一套重型网关基础设施。

设计取舍：

- **本地/个人使用优先**：默认监听 `127.0.0.1`，默认面向个人机器或私有网络；不面向公共代理、订阅转售、流量聚合或多租户计费场景。
- **轻量运维**：推荐路径是 Node.js + pnpm + 本机 `/admin`。不要求数据库、Redis、Kubernetes、服务网格或重型 API gateway 才能启动。
- **配置集中在 `/admin`**：账号 OAuth、模型 discovery、alias 绑定、Runtime API Key 创建和基础诊断都集中在本地管理台完成，减少手改配置和跨工具复制 secret。
- **客户端友好**：一个本地服务同时提供 Claude Messages、OpenAI Chat Completions、OpenAI Responses 和 Models API，方便 Claude Code、Anthropic SDK、OpenAI SDK 以及 OpenAI 兼容客户端接入。
- **轻量不等于玩具**：项目仍保留 OAuth/session 维护、模型 alias、Runtime/Admin key 分离、流式状态追踪、请求终态统计和安全日志边界。
- **权限边界清楚**：Runtime API Key 只给普通客户端调用 `/v1/*`；Admin API Key / `API_KEYS` 才用于管理账号和全局诊断，受保护 Admin API 会拒绝 Runtime Key。
- **日志可排障但不泄密**：记录请求耗时、stream 终态、events/bytes、错误分类和安全诊断；不记录 prompt、工具参数/结果、原始 provider payload、Authorization、cookie、token 或代理凭据。

一句话：它不是要把所有代理能力都塞进一个大平台，而是把 **个人 ChatGPT/Codex 账号会话** 稳定、清晰、低负担地适配成本机 Claude/OpenAI 兼容 API。

## 快速开始

Windows：

```bat
start.bat
```

Git Bash、Linux 或 macOS：

```bash
./start.sh
```

手动安装、检查并启动：

```bash
corepack pnpm setup
corepack pnpm check
corepack pnpm start
```

默认地址：

```text
http://127.0.0.1:3000
```

打开 Admin 控制台：

```text
http://127.0.0.1:3000/admin
```

默认 backend 是 `mock`。正常使用 ChatGPT/Codex session 时，打开 `/admin` 完成账号授权、模型发现和 Runtime API Key 生成。

### 自定义端口和监听地址

默认端口是 `3000`。如果该端口被占用，或你想同时运行多个实例，可以设置 `PORT`。

Git Bash、Linux 或 macOS：

```bash
PORT=3100 corepack pnpm start
```

PowerShell：

```powershell
$env:PORT = "3100"
corepack pnpm start
```

CMD：

```bat
set "PORT=3100"
corepack pnpm start
```

端口改成 `3100` 后，对应地址也要一起改：

| 用途 | 地址 |
| --- | --- |
| Admin 控制台 | `http://127.0.0.1:3100/admin` |
| Claude Code / Anthropic SDK Base URL | `http://127.0.0.1:3100` |
| OpenAI SDK / OpenAI 兼容 Base URL | `http://127.0.0.1:3100/v1` |
| 健康检查 | `http://127.0.0.1:3100/healthz` |

默认 `HOST=127.0.0.1`，只允许本机访问。一般个人本地使用不要改 `HOST`。如果改成非 loopback 地址（例如 `0.0.0.0`），必须预先设置 `API_KEYS`，并自行处理防火墙、反向代理、VPN 或其他网络访问控制；本项目不会帮你公开服务。

## 首次使用流程

1. 打开 `/admin`。
2. 点击 **添加 ChatGPT 账号**。
3. 在当前浏览器完成 Codex OAuth。
4. 等待服务验证 session、发现 backend models、持久化账号并初始化模型 alias。
5. 进入 **API 接入**。
6. 生成 Runtime API Key；可以填写名称，例如 `laptop`、`claude-code`、`local-dev`。
7. 立即复制页面一次性显示的 Runtime API Key；原始 key 只显示一次。
8. 使用页面生成的 Base URL、endpoint 和 curl 示例调用 `/v1/messages`、`/v1/models` 或 OpenAI 兼容接口。

OAuth 不会启动独立 Chrome 或新 profile。若浏览器拦截弹窗，或本地 callback 无法自动连通，可以使用页面保留的授权链接、复制完整 callback URL，或把完整 callback URL 粘贴回 Admin 页面继续完成流程。手动 access token / cookie 导入只是高级 fallback。

## Admin 控制台

Admin 控制台包含六个主要区域：

1. **概览**：查看账号 ready 状态、动态模型、可用 alias、Runtime Key 数量、配额缓存和最近账号活动摘要。
2. **账号与授权**：运行 Codex OAuth、恢复或取消 flow、检查账号健康与模型、重新授权、启用/停用、编辑或删除账号；专业模式提供手动 session 导入。
3. **模型**：把已发现 backend model 绑定到 alias，刷新 discovery，启用/停用 alias，设置默认控制项；专业模式可管理自定义 alias。
4. **API 接入**：生成、命名、复制、列出和撤销 Runtime API Key；查看 Base URL、endpoint 和动态 curl 示例。
5. **配额**：读取 provider allowance 缓存，刷新单个账号或全部账号，并区分 fresh、stale、error、unknown 状态。
6. **管理访问**：默认使用本机 HttpOnly 管理会话；专业模式在操作者自行让服务可达后提供 Admin API Key fallback。

控制台默认是简洁模式。专业模式会额外显示内部 ID、上游 ID、并发/冷却信息、安全错误码、discovery 诊断、完整动态模型列表、reasoning/service-tier 控制项、自定义 alias、手动 session 导入和 Admin API Key fallback。

## API 认证与 Key 类型

`/v1/*` 接受 Runtime API Key 或预配置的 `API_KEYS`。可以使用：

```text
Authorization: Bearer <runtime-api-key>
```

或：

```text
x-api-key: <runtime-api-key>
```

| 类型 | 用途 | 说明 |
| --- | --- | --- |
| Runtime API Key | 普通客户端调用 `/v1/*` | 可命名、可撤销；受保护 `/admin/api/*` 会拒绝 Runtime Key。 |
| Admin API Key | 外部管理 `/admin/api/*` | 完整管理权限，不要交给普通客户端、Claude 或第三方工具。 |
| `API_KEYS` | 启动前配置的服务端 allow-list | 可用于 `/v1/*` 和远程 Admin 管理。 |

安全边界：

- 本机 `/admin` 优先使用 HttpOnly、`SameSite=Strict` 的本地管理 cookie。
- 该 cookie 只在当前进程有效，服务重启后失效。
- 非 loopback 部署必须预先配置 `API_KEYS`，并自行处理防火墙、反向代理、VPN 或其他网络访问控制。
- OAuth access token、refresh token、ID token、cookie 和其他 session secret 不返回给前端、错误响应或 access log。

## 客户端配置

### Base URL 规则

Claude / Anthropic 兼容客户端使用服务根地址：

```text
http://127.0.0.1:3000
```

Claude Code 和 Anthropic SDK **不要**追加 `/v1`。

OpenAI 兼容客户端通常使用带 `/v1` 的地址：

```text
http://127.0.0.1:3000/v1
```

### Claude Code

Git Bash、Linux 或 macOS：

```bash
export ANTHROPIC_BASE_URL='http://127.0.0.1:3000'
export ANTHROPIC_AUTH_TOKEN='<runtime-api-key>'
claude
```

PowerShell：

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
  messages: [{ role: 'user', content: '你好' }],
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
  messages: [{ role: 'user', content: '你好' }],
});
```

## curl 验证

```bash
curl http://127.0.0.1:3000/healthz

curl http://127.0.0.1:3000/v1/models \
  -H 'Authorization: Bearer <runtime-api-key>'

curl http://127.0.0.1:3000/v1/messages \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <runtime-api-key>' \
  -d '{"model":"sonnet","max_tokens":128,"reasoning_effort":"medium","messages":[{"role":"user","content":"你好"}]}'

curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <runtime-api-key>' \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"你好"}]}'
```

如果 `/v1/models` 没有出现目标 alias，请在 Admin 的 **模型** 区刷新 discovery，选择可用 backend model，启用 alias 并保存。

## 常用环境变量

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

`CHATGPT_BASE_URL` 是上游 ChatGPT/Codex 地址，不是 Claude Code 的客户端 Base URL。

## 持久化与安全

默认数据目录是 `apps/api/data`，可用 `DATA_DIR` 修改。runtime state 保存账号 session、Runtime API Key 和 alias overlay；operational state 保存净化后的管理统计、discovery/cache、quota cache 和诊断信息。

如需加密 runtime state，设置 `STATE_ENCRYPTION_KEY`。它必须是严格标准 base64 的 32 字节随机密钥：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

不要提交 OAuth token、cookie、Runtime API Key、Admin API Key、`STATE_ENCRYPTION_KEY`、本地 runtime state、代理凭据或 `.env` 文件。

## 可选出站代理

```bash
OUTBOUND_PROXY_URL=http://127.0.0.1:7890
```

只接受 HTTP/HTTPS 代理 URL。SOCKS、路径、query、fragment 会被拒绝。代理只注入 ChatGPT/Codex 出站 fetch，例如 completion/SSE、discovery、OAuth exchange/refresh、health check、quota、reset-credit 调用；不会设置全局 dispatcher，也不会代理本地 Hono 请求或 OAuth loopback callback。

## 日志与流式时序

Access log 只安装在 `/v1/*` 和 `/admin/api/*`。默认 `ACCESS_LOG_FORMAT=text` 会输出请求开始行和响应就绪行。对 SSE，text 日志避免刷屏的生命周期噪声，只在流清理后输出一次真实终态：

- `STREAM DONE`
- `STREAM CANCELLED`
- `STREAM FAILED`

`detailed` 和 `json` 格式保留更多结构化生命周期元数据，方便 debug。日志字段经过 allowlist，不包含 prompt、工具参数/结果、原始 provider payload、header、token、cookie、session secret、代理凭据或完整 query value。

## 验证命令

```bash
corepack pnpm test
corepack pnpm build
corepack pnpm typecheck
```

或运行完整检查：

```bash
corepack pnpm check
```

## 文档

- [English README](README.en.md)
- [中文使用指南](docs/USAGE.zh-CN.md)
- [English usage guide](docs/USAGE.en.md)
- [协议兼容性说明](docs/protocol-compatibility.md)

## 技术栈

- pnpm workspace monorepo
- TypeScript strict mode
- Hono HTTP API
- Vitest
- Node.js runtime
