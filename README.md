# chatgpt-to-claude

**中文** | [English](README.en.md)

当前版本：**0.2.1** · [下载](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/releases/latest) · [安装与升级](INSTALL.md) · [更新记录](CHANGELOG.md)

`chatgpt-to-claude` 是一个 TypeScript + Hono 实现的本地兼容层：对外提供 Claude Messages、OpenAI Chat Completions、OpenAI Responses、Images、Models API 等接口，对内连接 mock backend 或真实 ChatGPT/Codex session backend。

本项目面向使用本人控制或已获明确授权的 ChatGPT/Codex 账号的个人本地/私有场景。它不是订阅聚合、流量转售、多租户共享网关或公共代理服务；不要把个人订阅流量公开转售，或面向不特定第三方大规模共享。

## 下载与安装

| 安装包 | 适合谁 |
| --- | --- |
| [Windows x64 免安装 ZIP](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/releases/download/v0.2.1/chat2claude-v0.2.1-windows-x64.zip) | 已包含 Node.js；解压后双击 `start.bat`。 |
| [通用 Node ZIP](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/releases/download/v0.2.1/chat2claude-v0.2.1-node.zip) | 已安装受支持 Node.js 的 Windows、Linux 或 macOS。 |
| [通用 Node TAR.GZ](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/releases/download/v0.2.1/chat2claude-v0.2.1-node.tar.gz) | Linux/macOS，解压后运行 `sh start.sh`。 |

这些包已包含编译后的服务与生产依赖，无需 pnpm 或自行构建。启动后打开 `http://127.0.0.1:3000/admin`，完成账号授权。通用包推荐 Node.js 24 LTS；GitHub 的 **Source code** 下载项需要按下方源码步骤安装。

[SHA-256 校验文件](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/releases/download/v0.2.1/SHA256SUMS) · [配置、数据迁移与升级](INSTALL.md) · [使用讨论](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/discussions) · [报告问题](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/issues/new/choose)

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
- **客户端友好**：一个本地服务同时提供 Claude Messages、OpenAI Chat Completions、OpenAI Responses、Images 和 Models API，方便 Claude Code、Anthropic SDK、OpenAI SDK 以及 OpenAI 兼容客户端接入。
- **轻量不等于玩具**：项目仍保留 OAuth/session 维护、模型 alias、Runtime/Admin key 分离、流式状态追踪、请求终态统计和安全日志边界。
- **权限边界清楚**：Runtime API Key 只给普通客户端调用 `/v1/*`；Admin API Key / `API_KEYS` 才用于管理账号和全局诊断，受保护 Admin API 会拒绝 Runtime Key。
- **日志可排障但不泄密**：记录请求耗时、stream 终态、events/bytes、错误分类和安全诊断；不记录 prompt、工具参数/结果、原始 provider payload、Authorization、cookie、token 或代理凭据。

一句话：它不是要把所有代理能力都塞进一个大平台，而是把 **个人 ChatGPT/Codex 账号会话** 稳定、清晰、低负担地适配成本机 Claude/OpenAI 兼容 API。

## 快速开始

以下是源码启动步骤；使用发布包请看上面的[下载与安装](#下载与安装)。

源码开发需要 Node.js 22.15.0 以上的 22.x，或 Node.js 24 及以上版本，以及 Corepack。项目固定使用 pnpm 9.15.4；Node.js 25 及以上需另行安装 Corepack。

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

`start` 只在首次启动、源码/编译配置/依赖变化或编译产物缺失、损坏时构建；普通重启会跳过 TypeScript 编译，直接启动一个 API 服务。`start.bat` / `start.sh` 同样生效，无需更换命令。`corepack pnpm build` 可强制重新构建，`corepack pnpm build --if-needed` 可单独检查并补齐构建而不启动服务。开发时使用 `corepack pnpm dev`，完成初始构建后监听 API 源码变化。

默认地址：

```text
http://127.0.0.1:3000
```

打开 Admin 控制台：

```text
http://127.0.0.1:3000/admin
```

`start.bat` / `start.sh` 默认使用 `session` 后端；直接运行 `corepack pnpm start` 且未设置 `CHATGPT_BACKEND` 时使用 `mock`。使用 ChatGPT/Codex session 时，在 `/admin` 完成账号授权、模型发现和 Runtime API Key 生成。

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

Ultra（主动协作）按模型目录解析基础推理强度，并鼓励使用客户端已有的委托工具。子代理由客户端执行；没有委托工具时直接完成任务。本服务不创建子代理，也不实现完整的 Codex 多代理运行时。详见[推理档位与 Ultra 主动协作](docs/USAGE.zh-CN.md#推理档位与-ultra-主动协作)。

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

### 独立 Images API

`POST /v1/images/generations` 使用现有 ChatGPT 账号调用 Codex 0.160 Images 服务，默认模型 `gpt-image-2`。2026-10-04，五个内置型号已在一个账号上以 `quality:low`、`n:1` 各完成一次实测，HTTP 200、最终 SSE 事件和 PNG 解码均通过，耗时约 13.4–15.5 秒。请求 `1024x1024` 时实际 PNG 均为 `1254×1254`；这不保证精确尺寸、所有账号或更高质量档位。OpenAI SDK 可沿用上面的 `client`：

```ts
const image = await client.images.generate({
  model: 'gpt-image-2', prompt: '白色背景上的简洁蓝色圆形',
  size: '1024x1024', quality: 'low', n: 1,
});
// image.data[0].b64_json 解码后是 PNG。
```

支持 JSON/base64 PNG、`n=1..10`。`stream:true` 仅支持 `n=1`，等上游 JSON 完成后发送一个 `image_generation.completed` 事件；没有中途预览，`partial_images` 只能省略或设为 0。独立超时 `CHATGPT_IMAGE_REQUEST_TIMEOUT_MS` 默认 300000 毫秒；图片限额为每项 16 MiB、每组 64 MiB、10 张，文本和隐藏 replay 限额不变。

`/v1/models` 的 `source: "image_endpoint"` 描述项指向此独立路由；将任一内置图片型号或绑定它的 alias 发到文本接口会得到 400。Responses 仅在上游提供图片事件时支持预览/最终图转换，当前宿主的 Responses 图片工具尚未真实验证；含生成图的 Responses 响应不存历史，返回 ID 不可用于 `previous_response_id`。Chat/Claude 收到图片输出会明确报 501，不返回空成功。完整参数、存图示例和限制见[使用说明](docs/USAGE.zh-CN.md#独立-gpt-image-生成)。

Admin 账号卡片分别显示文本模型与图片接口模型数量，例如 10 个文本模型、5 个图片接口模型；图片计数只统计本服务当前展示的接口模型项，不代表 OpenAI 全部图片型号。模型页在简洁和专业模式下都有独立图片模型面板。当前内置 `gpt-image-1.5`、`gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-2.5`，与 [CPA 的内置注册项](https://github.com/router-for-me/CLIProxyAPI/blob/8ef43e4df3b216a42493105d31c2873b69191473/internal/registry/model_definitions.go#L245)一致；裸 ID `gpt-image-2.5` 原值透传，不重命名成 Flare/Sunburst。2.5 系列的明确型号可使用 `xhigh`/`max` 质量，完整范围见使用说明。这些图片项来自独立的 `imageModels` 字段，不混入文本 `discoveredModels` 或 alias 候选，也不表示已验证该账号的图片生成权限。

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

`CHATGPT_BASE_URL` 是上游 ChatGPT/Codex 地址，不是 Claude Code 的客户端 Base URL。

模型目录可能受请求客户端版本控制。如果刷新成功却缺少新模型，请升级服务，并在专业模式检查 discovery 诊断中的 `clientVersion`。当前兼容基线为 `0.160.0`；可用 `CODEX_CLIENT_VERSION` 显式覆盖，旧环境变量也会覆盖更新后的默认值。修改版本后需重启服务并刷新账号模型。

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

更新依赖后，还可以运行 `corepack pnpm audit` 检查锁文件中的已知安全公告。测试工具链使用 Vitest 4 和 Vite 6；本轮验证环境为 Node.js 22.15.0。

GitHub Actions 配置了 Windows/Linux × Node.js 22.15.0/24 的检查矩阵；Linux Node 24 还执行依赖审计和安装包验证。`v*` 标签会触发发布工作流，只有 Linux 构建验证及 Windows 内置运行时检查都通过后才公开软件包；手动运行只生成检查工件，不发布版本。

制作发布包时，先提交变更，再运行：

```bash
corepack pnpm package:release
corepack pnpm package:smoke
```

产物写入 `dist-release/`。构建需要 Git、已按锁文件安装的开发依赖和下载官方 Node.js 运行时的网络连接；浏览器检查需要本机 Chrome 或 Edge，可通过 `PACKAGE_SMOKE_BROWSER_PATH` 指定。打包会从独立源码快照重新构建，默认拒绝脏工作区；`--allow-dirty` 只用于预检，带有该标记的包不应发布。

## 文档

- [安装包、配置与升级](INSTALL.md)
- [贡献指南](CONTRIBUTING.md)
- [获得帮助](SUPPORT.md)
- [安全报告](SECURITY.md) · [社区行为约定](CODE_OF_CONDUCT.md)
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

## 开源协议

MIT。详见 [LICENSE](LICENSE)。
