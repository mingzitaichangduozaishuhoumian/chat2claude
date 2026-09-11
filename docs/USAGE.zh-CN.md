# 使用 Claude Code 与管理后台

本指南说明如何启动 `chatgpt-to-claude`、完成本地 Codex OAuth、配置 Claude Code，并理解 `/admin` 控制台的实际行为。示例中的 token、cookie、API Key 和账号信息都是占位符。

## 1. 启动服务

在项目根目录执行：

```bat
start.bat
```

或在 Git Bash、Linux、macOS 执行：

```bash
./start.sh
```

也可以手动执行：

```bash
corepack pnpm setup
corepack pnpm check
corepack pnpm start
```

默认服务地址为 `http://127.0.0.1:3000`，管理后台为：

```text
http://127.0.0.1:3000/admin
```

如果设置了 `PORT`，请把所有示例中的 `3000` 换成实际端口。文档使用 `127.0.0.1` 是为了明确表示本机连接。

服务默认监听 loopback。若 `HOST` 不是 loopback，启动时必须预先设置 `API_KEYS`；`LOCAL_CONTAINER_BOOTSTRAP=true` 只用于容器监听 `0.0.0.0` 且宿主端口仍仅发布到 loopback 的场景。

## 2. Admin 的六个目的地

后台左侧导航固定提供六个目的地，页面 hash 也会反映当前目的地：

| 目的地 | 用途 |
| --- | --- |
| **概览（Overview）** `#overview` | 查看账号数量和健康摘要、已发现模型、可用 alias、Runtime Key 数量、配额缓存状态和最近账号活动。最近活动是摘要，不是完整请求日志。 |
| **账号与授权（Accounts & Authorization）** `#authentication` | 添加/重新授权 ChatGPT session、取消 OAuth、检查健康与模型、启用/停用/编辑/删除账号；专业模式提供手动 session 导入。 |
| **模型（Models）** `#models` | 查看 discovery、为 alias 绑定 backend model、启用/停用 alias、设置默认 reasoning/service tier；专业模式支持自定义 alias、refresh 和 reset。 |
| **API 接入（API Access）** `#api-access` | 创建、复制、查看安全前缀和撤销 Runtime API Key；查看动态 Base URL、endpoint 和 curl 示例。 |
| **配额（Quotas）** `#quota` | 读取 provider allowance 缓存，按账号或全部刷新；显示五小时、每周及其他上游窗口，缺失百分比不会伪显示为 0%。 |
| **管理访问（Admin Access）** `#admin-access` | 优先使用本机 HttpOnly 管理会话；专业模式提供在操作者自行连通服务后用于外部管理的 Admin API Key。 |

### 简洁模式与专业模式

后台默认使用**简洁模式**，适合完成正常授权、绑定 backend model、生成 Runtime API Key 和查看基本状态。它展示账号身份、套餐、启用状态、健康、请求结果、最近活动和模型数量。

**专业模式**额外显示：

- 账号内部 ID、上游 ID、凭据到期时间、并发、冷却时间和安全错误码；
- discovery 尝试/成功时间、安全诊断和完整动态模型列表；
- reasoning effort、service tier、能力元数据和配置问题；
- 自定义 alias 的创建、更新、删除、reset alias overlay、刷新 backend discovery；
- 高级手动 `accessToken`/cookie 导入；
- 操作者自行连通服务后用于外部管理的 Admin API Key。

模式偏好保存在当前浏览器的 `localStorage.adminViewMode`，只接受 `simple` 或 `professional`。它不是服务端账号配置，换浏览器或清理存储后会回到简洁模式。

### 语言记忆

后台默认简体中文，点击右上角 **English** 可切换英文。选择保存在当前浏览器的 `localStorage.adminLocale`，刷新后台后继续使用；只接受 `zh-CN` 或 `en`。页面会原地翻译静态文本、ARIA 属性、日期和数字，不会翻译账号标签或 provider 返回的模型名称。

OAuth 回跳只会在 `sessionStorage` 保存短期 `{ flowId, origin }` 定位信息，随后从地址栏移除 `oauth_flow`。其中不保存 code、state、code verifier、token、cookie、Admin Key 或 Runtime Key。

## 3. 完成 Codex OAuth

正常流程是浏览器授权，不依赖已登录的 `chatgpt.com` 页面抓 token：

1. 打开 `/admin`，点击“添加 ChatGPT 账号”。
2. 页面会先同步执行 `window.open('about:blank', '_blank')`，然后请求 OAuth flow；服务返回授权 URL 后导航新标签页。服务本身不会启动独立 Chrome 或新 profile。
3. flow 使用随机 flow ID、一次性 OAuth `state` 和 PKCE `code_verifier`/`code_challenge`。授权 scope 是实现中配置的 OpenID/profile/email/offline access 及 connectors scope，并带有 `originator=chat2claude`。
4. callback listener 优先在同一个端口同时绑定 IPv6 `::1`（IPv6-only）和 IPv4 `127.0.0.1`。默认端口是 `1455`；若该端口任一可用地址族无法完整监听，会关闭本轮 socket 并整体切换到 `1457`。IPv6 不可用时可以只使用 IPv4，不会绑定 wildcard 或 LAN 地址。
5. flow 默认十分钟过期。callback URL 必须完整匹配本次 flow 的 `http://localhost:<1455|1457>/auth/callback`，重复、冲突、错误 host/port/path、userinfo 或 fragment 会被拒绝；state 成功接收后只能消费一次。
6. callback 收到 code 后立即 single-flight 换 token，不等待下一次 polling。成功 listener callback 会以 `303` 回到 `/admin?oauth_flow=<flow-id>`；URL 只含非敏感 flow locator。
7. 服务自动 provisioning：验证 session，发现 backend models，保存 `chatgpt-session` 账号和模型 catalog；首次 session 账号会从 discovery 顺序中选择第一个模型绑定 `sonnet`，并在尚无 Runtime Key 时生成持久化 Runtime API Key。
8. 页面只展示脱敏账号信息、发现模型、绑定 alias、Base URL、endpoint 和一次性 Runtime API Key，不展示 access token、refresh token、id token、cookie 或其他 secret。

如果浏览器提示无法连接本地 callback：

1. 原样复制浏览器地址栏中的完整 `http://localhost:<port>/auth/callback?...` URL；
2. 在“账号与授权”的 callback 输入框粘贴；
3. 点击“提交 callback URL”，页面会继续 exchange/provisioning。

取消授权只取消当前服务端 flow，不会启动或关闭浏览器。服务重启后 flow 不再存在，页面会提示流程过期并要求重新授权。

### 高级手动导入

仅在 OAuth 无法使用或已有可用 session secret 时，在专业模式展开“高级：手动导入 accessToken / cookie”。可以新增账号或重新授权已有 `chatgpt-session` 账号；表单提交后服务仍会执行相同的 session 验证、模型发现和持久化流程。表单和响应不会返回 secret。

## 4. Runtime API Key、Admin API Key 与静态 API_KEYS

三者的**命名用途**不同，且当前服务端会把 Runtime API Key 限制为客户端凭据：

| 凭据 | 主要用途 | 认证位置 |
| --- | --- | --- |
| Runtime API Key | 客户端调用 `/v1/*`；受保护的 `/admin/api/*` 路由会拒绝 Runtime Key | `Authorization: Bearer <key>` 或 `x-api-key: <key>` |
| Admin API Key | 操作者自行连通服务后外部调用 `/admin/api/*` 的完整管理凭据；不得作为普通用户、Claude 或 API 凭据分享 | `Authorization: Bearer <key>` 或 `x-api-key: <key>` |
| `API_KEYS` | 启动前配置的服务端静态允许列表；可作为 `/v1/*` 和远程 Admin API 的 key | 同上 |

因此 Runtime API Key 与 Admin API Key 在签发、用途和授权行为上都已区分；普通客户端应使用 Runtime API Key，Admin API Key 仍是完整管理凭据。

优先在宿主机本地浏览器使用 HttpOnly 管理会话。只有操作者自行通过 LAN、VPN/mesh VPN、SSH 隧道、反向隧道/NAT 穿透或反向代理使服务可达后，才从其他浏览器、设备或自动化使用 Admin API Key；本项目不创建隧道、不配置 NAT、也不发布服务。

本机 loopback 访问 `/admin` 时，服务会签发进程级随机 HttpOnly、`SameSite=Strict`、`Path=/admin` cookie。该 cookie：

- 只在服务当前进程有效，重启后失效；
- 只接受可信 loopback Host；
- 只能用于 Admin API，不能用于 `/v1/*`；
- 对写操作要求同源 `Origin`；
- 远程访问、自动化或会话不可用时必须改用显式 Admin API Key。

Runtime API Key 的原始值只在创建/生成后的当前页面显示一次。生成时可以填写 1-64 个字符的可选显示名称；服务端会 trim 名称，并拒绝重复名称，避免误替换已有命名 Key。列表只显示 ID、名称、创建时间和安全前缀，不会再次显示原始值。遗失时生成新 Key；旧 Key 不会自动撤销，如需作废请在 Key 列表中撤销旧记录。

启动前固定服务端 key 的示例：

```bash
API_KEYS='<key-1>,<key-2>' ./start.sh
```

开发环境的 `/admin/api/api-keys/dev-enable` 可生成 `sk-dev-...` key；`NODE_ENV=production` 时该入口禁用。正常 Runtime Key 使用 `sk-runtime-...` 前缀。

## 5. Base URL 与 Claude Code 配置

Claude Code 的 Base URL 必须填写服务根 origin，**不要包含 `/v1`**：

```text
http://127.0.0.1:3000
```

错误示例：

```text
http://127.0.0.1:3000/v1
```

项目的实际 Claude Messages endpoint 是 `POST /v1/messages`，客户端会在根 Base URL 后拼接路径。若 `PORT=3100`，使用 `http://127.0.0.1:3100`。

### 临时环境变量

PowerShell：

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3000"
$env:ANTHROPIC_AUTH_TOKEN = "<runtime-api-key>"
claude
```

CMD：

```bat
set "ANTHROPIC_BASE_URL=http://127.0.0.1:3000"
set "ANTHROPIC_AUTH_TOKEN=<runtime-api-key>"
claude
```

Git Bash、Linux 或 macOS：

```bash
export ANTHROPIC_BASE_URL='http://127.0.0.1:3000'
export ANTHROPIC_AUTH_TOKEN='<runtime-api-key>'
claude
```

`ANTHROPIC_AUTH_TOKEN` 会以 Bearer token 发送。Claude Code 配置使用 Runtime API Key，不要填 Admin API Key。

### 安全检查，不打印完整 key

PowerShell：

```powershell
if ([string]::IsNullOrWhiteSpace($env:ANTHROPIC_BASE_URL)) { throw "ANTHROPIC_BASE_URL 未设置" }
if ([string]::IsNullOrWhiteSpace($env:ANTHROPIC_AUTH_TOKEN)) { throw "ANTHROPIC_AUTH_TOKEN 未设置" }
Write-Output "ANTHROPIC_BASE_URL=$env:ANTHROPIC_BASE_URL"
Write-Output "ANTHROPIC_AUTH_TOKEN=已设置（内容已隐藏）"
Invoke-RestMethod "$env:ANTHROPIC_BASE_URL/healthz" | Out-Null
Write-Output "healthz=OK"
```

Git Bash、Linux 或 macOS：

```bash
: "${ANTHROPIC_BASE_URL:?ANTHROPIC_BASE_URL 未设置}"
: "${ANTHROPIC_AUTH_TOKEN:?ANTHROPIC_AUTH_TOKEN 未设置}"
printf 'ANTHROPIC_BASE_URL=%s\n' "$ANTHROPIC_BASE_URL"
printf 'ANTHROPIC_AUTH_TOKEN=已设置（内容已隐藏）\n'
curl --fail "$ANTHROPIC_BASE_URL/healthz"
```

### Claude Code settings 示例

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

该文件含访问凭据，不要提交仓库、同步到公共位置或分享给他人。修改后关闭已有 Claude Code 会话并重新加载终端或 VS Code。

### 客户端兼容速查

Base URL 必须匹配客户端族。会自行追加 `/v1/...` 的客户端应使用服务根地址，例如 Claude Code 和 Anthropic TypeScript SDK。OpenAI 兼容客户端通常需要以 `/v1` 结尾的版本化地址。不能把根地址给不会自行追加 `/v1` 的客户端，也不能重复追加 `/v1`。

Claude Code 使用上文的根地址。Anthropic TypeScript SDK 同样使用根地址：

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

OpenAI TypeScript SDK 使用版本化地址和已支持的 OpenAI 兼容路由：

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

`POST /v1/messages/count_tokens` 只返回 `{ "input_tokens": number }`，它是本地 heuristic，不是 Anthropic tokenizer 的精确计数；成功响应会包含 `x-chat2claude-token-count-mode: heuristic`。`GET /v1/models` 保持 OpenAI 风格的顶层 `{ "data": [...] }`，单个模型可附带 capabilities、`token_counting_mode` 等项目元数据。

### 真实客户端 smoke 矩阵

所有客户端 smoke 检查都使用 Runtime API Key；不要把 Admin API Key 当作普通客户端凭据。

| Client | Base URL | 主要 smoke endpoint |
| --- | --- | --- |
| Claude Code | `http://127.0.0.1:3000` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models` |
| Anthropic SDK | `http://127.0.0.1:3000` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models` |
| OpenAI SDK | `http://127.0.0.1:3000/v1` | `/v1/chat/completions`, `/v1/responses`, `/v1/models` |
| Cline | `http://127.0.0.1:3000` | `/v1/messages`, `/v1/models` |
| Roo | `http://127.0.0.1:3000` | `/v1/messages`, `/v1/models` |
| Continue | `http://127.0.0.1:3000/v1` | `/v1/chat/completions`, `/v1/models` |
| Cherry Studio | `http://127.0.0.1:3000/v1` | `/v1/chat/completions`, `/v1/models` |

Claude Code、Anthropic SDK、Cline 和 Roo 按 Claude/Anthropic 兼容客户端配置，Base URL 使用根 origin。OpenAI SDK、Continue 和 Cherry Studio 按 OpenAI 兼容客户端配置，Base URL 使用带 `/v1` 的版本化 origin。

## 6. 模型 alias、discovery 与 reasoning/speed

### 内置 alias

| Alias | 默认 reasoning effort | 初始行为 |
| --- | --- | --- |
| `sonnet` | `medium` | 首次 session provisioning 会绑定 discovery 返回的第一个 backend model；建议先验证它。 |
| `haiku` | `low` | 内置但通常未绑定；需在模型映射中选择已发现的 backend model。 |
| `fable` | `high` | 可配置内置 alias，不是硬编码生产模型 ID；需先绑定。 |
| `opus` | `high` | 内置但通常未绑定；需先绑定。 |

模型来源不是静态生产模型表：

- `MODEL_REGISTRY_JSON` 存在时优先作为 alias overlay 配置；否则读取 `config/models.json`。
- session backend 在有账号上下文时从上游 discovery 获取模型；无账号启动 discovery 可能为空。
- mock backend 可通过 `MOCK_BACKEND_MODELS_JSON` 提供 discovery。
- OAuth provisioning 和账号健康/模型刷新会使用账号上下文刷新 catalog。
- `/v1/models` 只返回已启用且状态为 `bound` 或 `passthrough` 的 alias/discovery 模型；`unbound` 和 `stale` 不会列出。每个模型还包含从运行时模型元数据派生的 `capabilities`、稳定的 `capability_projection`，以及 `token_counting_mode: "heuristic"`；顶层结构仍是 `{ "data": [...] }`。
- 已存在的持久化或手动 alias binding 不会被服务重启时的 discovery refresh 随意覆盖；refresh 只在需要绑定时使用 discovery。

模型映射的 Backend Model 下拉只来自当前 discovery。专业模式中的 reasoning effort、service tier 和默认值也来自所选目标的能力元数据；元数据未知时不会假设所有控制项都可用。显式请求不支持的 `reasoning_effort` 或 service tier 会返回 400，而不是静默改写。

### Token 计数

`POST /v1/messages/count_tokens` 保持 Claude 兼容的响应 body 结构不变：

```json
{ "input_tokens": 123 }
```

该值是本地启发式估算，不等同于 Anthropic tokenizer 计数。成功响应会包含 `x-chat2claude-token-count-mode: heuristic`；需要精确计费或上下文限制的客户端不能把它当作 Anthropic 精确计数。

## 7. 配额、日志和计时边界

### 配额

后台首次加载配额只读取本地缓存，不触发上游请求。刷新按账号去重；批量刷新允许部分成功。页面按 provider 实际返回的 `durationSeconds` 识别五小时窗口（18,000 秒）和每周窗口（604,800 秒），其他窗口原样列出。

未知或缺失的 `usedPercent` 不会显示为 0% 进度条，也不会从套餐名称、429 或请求统计推断剩余额度。配额状态区分 `fresh`、`stale`、`error`、`unknown`；不支持 quota lookup 的账号会明确显示不可用。

### 可选出站代理（Clash）

设置 `OUTBOUND_PROXY_URL=http://127.0.0.1:7890` 使用本机 Clash 混合端口（无需用户认证）；也可用 `http://127.0.0.1:7892` 的 HTTP 端口。未设置或留空时直连。只接受 HTTP/HTTPS 代理 URL；SOCKS、路径、查询参数和 fragment 会被固定安全错误拒绝。支持 URL 用户名/密码，但必须作为密钥保护，不要贴入日志或公开截图。

实现采用兼容 Node 22.15 的外部 Undici 7 `ProxyAgent`，仅显式注入 ChatGPT/Codex 出站 fetch：完成/SSE、模型发现、健康检查、配额/重置额度、OAuth 换码和刷新。不设置全局 dispatcher，不依赖 `NODE_USE_ENV_PROXY`，不代理本地 Hono 请求、OAuth 本地回调或浏览器导航；app dispose 时关闭 dispatcher。代理 URL 不进入日志、Admin API 或 DOM。Docker 中的 loopback 指容器自身，需要改用容器可达的宿主地址（如 Docker Desktop 的 `host.docker.internal`）。

### HTTP access log

access log 只应用于 `/v1/*` 和 `/admin/api/*`。默认 `ACCESS_LOG_FORMAT=text` 输出对齐的双箭头：请求开始时 `[...] <-- METHOD path`，响应就绪时 `[...] --> STATUS [STREAMING] | duration | METHOD path?query`。SSE 在响应就绪时立即记录，不读取、clone、tee 或延迟 body。text 模式避免流生命周期噪声，只在流清理后输出一次真实终态：`STREAM DONE`、`STREAM CANCELLED` 或 `STREAM FAILED`，携带累计 counts/bytes/duration。`simple` 兼容归一化为 `text`；`detailed`/`json` 可保留安全结构化字段、首次 `STREAM START` 生命周期和终态；不再按固定时间输出 `STREAM ACTIVE`。日志不会记录 prompt、工具参数/结果、加密内容、provider 原始 payload、header、token、cookie、会话或代理凭据。

```text
[2026-09-08 13:12:03] [c6a432ed] [INFO ] [  api  ] <-- POST /v1/messages?beta
[2026-09-08 13:12:08] [c6a432ed] [INFO ] [ opus  ] --> 200 STREAMING | 4.681s | POST /v1/messages?beta
[2026-09-08 13:12:21] [c6a432ed] [ERROR] [ opus  ] --> STREAM FAILED | 17.598s | events=42 bytes=8192 | invalid_response
```

文本使用主机本地完整日期时间 `YYYY-MM-DD HH:mm:ss`；JSON 时间仍为 ISO UTC。固定列依次为时间、服务端 UUID 前 8 位、5 字符大写等级、居中的 7 字符 model/类别、箭头。model 先清理控制字符再截断；未知 model 时按规范化 path 显示安全类别：`/v1/*` 为 `api`、`/admin/*` 为 `admin`、其他为 `system`。耗时以秒表示并保留三位小数；两个方向都包含安全 query 类别（`beta` / `other`，不含值）。文本不含源码文件名或 IP；结构化 peer IP 仅来自连接，不信任转发头。结构化记录包含：

- request ID、HTTP method、归一化 path；
- 查询参数类别（只保留 `beta`，其他归为 `other`）；
- HTTP status、peer IP；
- 已通过路由校验的 model ID 和 stream 标志；
- `durationMs` 和 `durationKind: response_ready | stream_lifecycle | stream_terminal`。

它**不会读取或记录** request body、response body、token、cookie、Authorization、API Key、OAuth code/state/verifier 或完整查询值。动态 flow/account/key/model ID 会被归一化为占位路径；非法或过长模型 ID 会被写成安全占位符。

三个协议保留现有 readiness barrier：有效上游帧通过校验后才发送 SSE 200/prelude；该 200 表示响应就绪，不保证最终成功。普通请求使用 `durationKind: response_ready`。流在清理后恰好确定一个终态；默认 text 恰好输出一条终态行：`STREAM DONE`、`STREAM CANCELLED` 或安全的 `STREAM FAILED`。detailed/JSON 保留成功、失败、取消终态及完整安全指标，`durationKind: stream_terminal` 的耗时从请求进入开始（包含账号等待）。headers 发出后的失败仍保留 HTTP 200。`invalid_response` 的 detailed/JSON 诊断仅包含固定 allowlist 的 `protocolStage` / `protocolReason`，区分 SSE JSON、lifecycle/text/part/output item、incomplete、缺失成功终态、工具收尾和 replay snapshot；不记录 provider message/detail/原始 param 或 payload。EOF/`[DONE]` 不等于成功，custom backend 的 done 省略 `terminalSuccessful` 仍兼容，仅显式 false 被拒绝。静默上游期间默认每 15 秒发送 `: keepalive` SSE 注释（`SSE_KEEPALIVE_INTERVAL_MS=0` 可关闭），成功终态、取消或错误会停止 keepalive。实际客户端断开会静默关闭 HTTP body、取消上游并释放账号，不产生新的 AbortError 写入栈；内部 teardown abort 不作为客户端取消证据。上游 AbortError、超时和协议错误仍计为失败。响应前取消保留 499（账号获取期间仍为原有 503）。日志/统计异常不能阻止账号释放；middleware 不读取、clone 或 tee body。

Claude 终态仅增加数字/boolean 指标：sourceMessageCount 为 messages 长度，sourceContentBlockCount 为 messages 内容块总数（string 算 1，system 不计入这两项）；upstreamBodyBytes 为发送给 fetch 的唯一最终 JSON 字符串的 UTF-8 精确字节；toolCount、toolSchemaBytes 为工具数量 / schema JSON UTF-8 总字节；upstreamInputItemCount、replayItemCount、replayApplied 描述实际输入和 replay。system、history、工具参数、图片、密文只计字节，不记内容。内部 callback 回传，并由日志 allowlist 再过滤；客户端 JSON 无法伪造。fetch 前计算，因此 timeout 仍保留已知规模。JSON 包含完整指标，detailed 显示关键字段。无 access middleware 的独立路由保留安全 terminal 应用事件作兼容回退。

请求 release 时，`unauthorized` 保持 unhealthy，需成功健康检查或重新授权恢复；`rate_limited` 保持 cooldown。`network_error`、`timeout`、`upstream_error`、`invalid_response` 仅保留固定本地诊断和安全错误码，原本健康的账号释放后仍 available、可立即重新获取。`invalid_request` 属于请求级错误，会清除临时诊断而不污染健康。成功或请求级错误 release 不会覆盖并发请求已设置的 unhealthy/cooldown。显式健康检查失败仍可能设为 error。

### 有界账号并发等待

Messages、Chat Completions 和 Responses 采用相同的通知式获取策略。只要存在匹配 provider、capability、模型和控制项，且除此之外可用、仅并发已满的账号，就等待槽位而不是立即返回 503。`ACCOUNT_ACQUIRE_TIMEOUT_MS` 默认 `30000`，`0` 恢复立即失败行为；接受 `0..2147483647` 整数毫秒，非法值会阻止启动。每个等待者只有一个固定截止时间，不轮询，也不因通知延长期限。

释放、健康恢复、启用、删除和配置更新会通知已有等待者。等待者通过同步获取竞争槽位，仍遵守 Admin 中的 `maxConcurrency`。获取成功、超时、请求 AbortSignal 取消或状态变为非并发不可用时，都会移除等待者、定时器和 abort 监听器。冷却、不健康、停用、无账号和模型不兼容不进入等待，也不会等待重新授权或冷却到期。

| 固定 reason | 含义 |
| --- | --- |
| `no_account` | 没有匹配 provider 的账号 |
| `capability_unavailable` | 匹配 provider 的账号不具备所需 capability |
| `model_or_controls_unsupported` | 没有候选账号支持请求的模型/控制项 |
| `account_disabled` | 匹配账号均停用 |
| `account_unhealthy` | 匹配的启用账号均处于 unhealthy（如凭据未授权） |
| `account_error` | 排除 unhealthy 后，剩余匹配账号均处于 error（如手动健康检查失败） |
| `account_cooldown` | 剩余匹配账号处于冷却 |
| `account_busy` | 匹配的可用账号并发已满，且等待配置为 0 |
| `account_busy_timeout` | 等待槽位超时 |
| `request_aborted` | 获取账号期间客户端取消 |

诊断依次筛选 provider、capability、模型/控制项、启用、健康、冷却和并发，混合账号池也有确定性结果；空闲但不兼容的账号不会掩盖符合条件的忙账号。session 预检查保留无可用账号时先于全局模型解析返回 503 的行为，但放行忙账号以继续完整模型/控制项筛选。原有模型校验的 400/404 不变。

原因仅用于内部调度和日志，不暴露账号 ID、原始异常、上游正文，也不新增 API/SSE 字段。获取失败仍是原有 503 / `overloaded_error` 和各协议错误外壳；已经断开的客户端可能无法收到响应。SSE 初始 200 **不会释放并发槽**，仍由生成器 `finally` 在流完成、错误或取消清理后释放。访问日志耗时包含账号等待及 SSE 迭代器至终态的全部时间，而非单独的上游延迟。

### 后台请求统计

账号卡片的成功、失败、取消、总请求数、token 累计、最近请求时间和 in-flight 数量来自独立的运营状态统计，不是完整访问日志。运营状态会 debounce 写入 `admin-operational-state.json`；`inFlight` 不持久化，重启后恢复为 0。统计持久化失败不会改变 provider 响应、账号释放或冷却逻辑。`/metrics` 仍为 JSON，返回有界 request log 聚合（保留数量、流数量和路由数量）；配置了运营状态时还会返回账号/请求/token 的聚合计数。它不会返回请求内容、header、cookie、token、工具参数或 secret。使用本地 Admin 会话或服务端 `API_KEYS` Admin key 的操作者可调用 `GET /admin/api/diagnostics/requests`，其中同样只包含有界且安全的元数据：route、model、stream 标记和时间戳。Runtime API Key 会被拒绝访问这个全局检查器，避免一个客户端读取其他客户端的请求元数据。

## 8. 持久化、密钥与安全文件

默认数据目录是 API 应用的 `data` 目录。可设置：

```bash
DATA_DIR=./custom-data
```

runtime state 位于 `${DATA_DIR}/runtime-state.json`，保存账号 session secret、Runtime API Key 和 alias overlay；运营状态位于 `${DATA_DIR}/admin-operational-state.json`，保存脱敏请求统计、健康、发现 catalog 和配额缓存。服务使用临时文件、fsync 和原子 rename，并尽量设置目录 `0700`、文件 `0600`。

可选的 `STATE_ENCRYPTION_KEY` 会使用 AES-256-GCM 加密 runtime state。它必须是无空白、严格标准 base64 的 32 字节 key（44 个字符，末尾一个 `=`）。生成占位配置值：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

把完整输出放进本地 `.env`，不要把输出写入文档或提交记录。加密文件启动时必须提供同一 key；没有 key 或 key 不匹配会拒绝读取状态。

## 9. 环境变量

常用值：

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

Session 生成不再使用 OAuth 短请求总时限。`CHATGPT_REQUEST_TIMEOUT_MS` 默认 60000，仅用于 OAuth/token/discovery/配额等短操作。`CHATGPT_RESPONSE_HEADER_TIMEOUT_MS` 默认 60000，限制 fetch 到 headers；`CHATGPT_STREAM_IDLE_TIMEOUT_MS` 默认 300000，从 headers 后等待首个非空 raw body chunk，之后每个非空 chunk 都续期（reasoning、tool、SSE comment、拆分帧均算活动，空 chunk 不算）。`CHATGPT_STREAM_TOTAL_TIMEOUT_MS` 默认 0，明确关闭绝对生成上限；大于 0 时从 fetch 开始计时，即使流活跃也终止。前两项须为 1..2147483647 整数，总上限允许 0；非法配置拒绝启动。超时仍是 backend code=timeout/status=504，安全 timeoutKind 仅为 response_headers / stream_idle / stream_total；调用方取消优先，不计账号失败。reader.cancel 清理最多等待 250ms。

包 API 迁移：旧 `timeoutMs` 单独使用仍保留绝对总时限和短操作时限；它已 deprecated。传入任一新字段即启用新分阶段语义，未指定总上限默认为 0；`requestTimeoutMs` 只管短操作。API app 显式传入所有新字段，不把旧环境变量当作生成上限。

`CHATGPT_BASE_URL` 是 session backend 请求上游 `/backend-api/codex/responses` 和 discovery 的地址，不是 Claude Code 的客户端 Base URL。客户端 Base URL 仍然是服务根 origin，例如 `http://127.0.0.1:3000`。

## 10. 连接验证

```bash
curl http://127.0.0.1:3000/healthz

curl http://127.0.0.1:3000/v1/models \
  -H 'Authorization: Bearer <runtime-api-key>'

curl http://127.0.0.1:3000/v1/messages \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <runtime-api-key>' \
  -d '{"model":"sonnet","max_tokens":64,"messages":[{"role":"user","content":"你好"}]}'
```

如果 `GET /v1/models` 没有 `sonnet`，先在 `/admin` 刷新 discovery 并确认 alias 已绑定、启用且 backend model 仍然存在。

## 11. 常见问题

| 现象 | 处理 |
| --- | --- |
| `/v1/*` 返回 401 | 使用 Runtime API Key 或 `API_KEYS`；浏览器 Admin cookie 不能用于 `/v1/*`。 |
| Admin 写操作返回 401/403 | 本地会话可能已失效；专业模式输入 Admin API Key。cookie 写操作还必须带同源 `Origin`。 |
| 地址出现重复 `/v1` | `ANTHROPIC_BASE_URL` 错误地包含 `/v1`；改为服务根 origin。 |
| `message.role must be user or assistant` | Claude Messages 的 `messages` 只使用 `user`/`assistant`；系统提示放顶层 `system`。不要把 Claude 请求发到 OpenAI 兼容路径。 |
| alias 未绑定、stale 或 disabled | 在模型映射刷新 discovery，选择当前存在的 backend model，启用 alias 并保存。 |
| OAuth callback 无法连接 localhost | 复制完整 callback URL，粘贴到账号与授权页面提交；服务会校验 redirect URI、state 和参数。 |
| 配额显示未知或陈旧 | 这是 provider 返回状态的真实表示；按账号或全部刷新，不能把未知当作 0%。 |
| 重启后页面不记得模式/语言 | 模式和语言只记在当前浏览器 localStorage；换浏览器、清除站点存储或隐私模式会恢复默认。 |

## 12. 验证命令

```bash
corepack pnpm test
corepack pnpm build
corepack pnpm typecheck
```
