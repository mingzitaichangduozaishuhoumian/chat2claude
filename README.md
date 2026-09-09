# chatgpt-to-claude

`chatgpt-to-claude` 是一个 TypeScript + Hono 的个人自托管、local-first 兼容层：对外提供 Claude Messages、OpenAI Chat Completions、OpenAI Responses 和 Models API，对内连接 mock backend 或真实 ChatGPT session backend。

本项目面向使用本人控制或已获明确授权的 ChatGPT/Codex 账号的个人自托管场景。它不是订阅聚合、流量转售或多租户共享网关；不要把个人订阅流量公开转售或面向不特定第三方大规模共享。

## 快速开始

### 启动

Windows：

```bat
start.bat
```

Git Bash、Linux 或 macOS：

```bash
./start.sh
```

然后打开：

```text
http://127.0.0.1:3000/admin
```

也可以手动运行：

```bash
corepack pnpm setup
corepack pnpm check
corepack pnpm start
```

默认监听 `127.0.0.1:3000`。服务默认使用 `mock` backend；一键启动脚本在未设置 `CHATGPT_BACKEND` 时会提示使用 `/admin` 完成 Codex OAuth，并将普通用户流程切换到 `session` backend。

### 首次使用

1. 打开 `/admin`。
2. 点击“添加 ChatGPT 账号”，在当前浏览器完成 Codex OAuth。
3. 服务会验证 session、发现模型、创建或更新 ChatGPT session 账号，并在首次初始化时生成 Runtime API Key。
4. 立即复制页面一次性显示的 Runtime API Key。
5. 使用页面生成的 Base URL 和 `/v1/messages` 示例调用服务。

OAuth 不会启动独立 Chrome 或新 profile；浏览器弹窗被拦截时，可以点击保留的授权链接、复制 URL，或粘贴完整 callback URL。手动 access token/cookie 导入仅是高级 fallback。

## Admin 控制台

`/admin` 有六个固定目的地：

1. **概览（Overview）**：读取账号、动态模型、可用 alias、Runtime Key 数量、配额缓存和最近账号活动摘要。
2. **账号与授权（Accounts & Authorization）**：完成 Codex OAuth、取消或恢复流程，查看账号健康与请求结果，重新授权、启用/停用、编辑并删除账号；高级区域可手动导入 session。
3. **模型（Models）**：把已发现的 backend model 绑定到 alias，刷新 discovery，调整启用状态和默认控制项；专业模式可管理自定义 alias。
4. **API 接入（API Access）**：生成、复制和撤销 Runtime API Key，查看根 Base URL、`POST /v1/messages` endpoint 和动态 curl 示例。
5. **配额（Quotas）**：读取缓存的 provider allowance；按账号或全部刷新，并区分新鲜、陈旧、错误和未知状态。
6. **管理访问（Admin Access）**：优先使用本机 HttpOnly 管理会话；专业模式提供在操作者自行连通服务后用于外部管理的 Admin API Key。

控制台默认是简洁模式。专业模式额外显示内部/上游 ID、并发、冷却、安全错误码、发现诊断、完整动态模型、推理/服务层级选项、自定义 alias、手动 session 导入和 Admin API Key fallback。简洁/专业模式偏好保存在当前浏览器的 `localStorage.adminViewMode`；语言偏好保存在 `localStorage.adminLocale`。服务端不把这些 UI 偏好写入 runtime state。

管理页面默认简体中文，也可切换 English。切换会原地翻译页面文本、ARIA 属性、日期和数字，并在刷新后沿用当前浏览器选择；账号标签、provider 返回的模型名称等动态值不被擅自翻译。

## 认证与密钥

- `/v1/*` 使用 Runtime API Key 或预配置的 `API_KEYS`，使用 `x-api-key: <key>` 或 `Authorization: Bearer <key>`。
- 优先在宿主机本地浏览器使用 HttpOnly 管理会话。只有操作者自行经 LAN、VPN/mesh VPN、SSH 隧道、反向隧道/NAT 穿透或反向代理使服务可达后，才从其他浏览器、设备或自动化使用 Admin API Key；本项目不创建隧道、不配置 NAT、也不发布服务。
- Admin API Key 授予完整管理权限，不要作为普通用户、Claude 或 API 凭据分享；普通客户端应使用 Runtime API Key。受保护的 `/admin/api/*` 路由会拒绝 Runtime Key，远程或自动化管理请使用服务端 `API_KEYS` / Admin API Key 或本机 HttpOnly 管理会话。
- Runtime Key 原始值只在创建/生成后的当前页面显示一次。列表只显示稳定 ID、名称、创建时间和安全前缀；遗失后应撤销旧 Key 并生成新 Key。
- 本机 loopback 访问 `/admin` 会获得仅当前进程有效的 HttpOnly、`SameSite=Strict` cookie。写操作还要求同源 `Origin`。服务重启后 cookie 失效。
- 非 loopback 启动必须预先配置 `API_KEYS`，除非仅供宿主机回环访问的容器设置 `LOCAL_CONTAINER_BOOTSTRAP=true`。
- OAuth access token、refresh token、id token、cookie 和其他 session secret 不返回给前端、错误响应或日志。

## Base URL 与调用示例

客户端 Base URL 必须是服务根 origin，不要附加 `/v1`：

```text
http://127.0.0.1:3000
```

```bash
curl http://127.0.0.1:3000/healthz

curl http://127.0.0.1:3000/v1/models \
  -H 'Authorization: Bearer <runtime-api-key>'

curl http://127.0.0.1:3000/v1/messages \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <runtime-api-key>' \
  -d '{"model":"sonnet","max_tokens":128,"reasoning_effort":"medium","response_speed":"balanced","messages":[{"role":"user","content":"你好"}]}'
```

管理后台中的 curl 和 endpoint 使用 `window.location.origin` 动态生成，因此自定义 `PORT` 时不会写死 `3000`。

## OAuth、账号与模型发现

Codex OAuth 使用 authorization code + PKCE。服务为每个 flow 生成高熵 flow ID、一次性 state 和 code verifier；授权链接使用 `auth.openai.com`，回调固定为 `http://localhost:<port>/auth/callback`。listener 优先同时绑定 IPv6 `::1` 和 IPv4 `127.0.0.1`，默认端口 `1455` 被占用时整体切换到 `1457`。flow 默认十分钟过期，callback code 只消费一次。

收到 callback 后服务立即 single-flight 换 token，不等待下一轮页面 polling；成功后才执行 provisioning：验证 session、请求 backend model discovery、原子提交账号/模型/Runtime Key，并在首次 session 账号初始化时绑定 `sonnet` 到 discovery 返回的第一个模型。后续 refresh 不会覆盖已有有效的 alias 绑定。运行时会在 token 到期前主动 refresh；同一账号的并发 refresh 会合并。

后端模型不是静态源码表：session backend 使用账号上下文发现模型，mock backend 可用 `MOCK_BACKEND_MODELS_JSON`；`/v1/models` 只返回已启用且已解析的 alias，以及未被 alias 覆盖的 discovery passthrough 模型。alias overlay 来源优先级为 `MODEL_REGISTRY_JSON`，否则是 `config/models.json`。内置 alias 为 `haiku`、`sonnet`、`fable`、`opus`；未绑定或 stale 的 alias 不可调用。模型的 reasoning effort、service tier 和默认值以选定 backend discovery 的能力元数据为准，显式发送不支持的控制项会被拒绝。

## 持久化与安全文件

默认数据目录是 API 应用的 `data` 目录；可通过 `DATA_DIR` 修改。账号、Runtime Key 和 alias overlay 保存于 `runtime-state.json`；管理运营统计和发现/配额缓存保存于 `admin-operational-state.json`。文件使用临时文件、fsync、原子 rename 写入，并尽量设置目录 `0700`、文件 `0600`。

如设置 `STATE_ENCRYPTION_KEY`，runtime state 使用 AES-256-GCM 加密。它必须是严格标准 base64 的 32 字节密钥（44 个字符，末尾一个 `=`）：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

不要把真实 token、cookie、API Key 或加密密钥写入文档、提交记录或公共位置；示例中的凭据均为占位符。

### 可选出站代理（Clash）

设置 `OUTBOUND_PROXY_URL=http://127.0.0.1:7890` 使用本机 Clash 混合端口（无需用户认证）；也可用 `http://127.0.0.1:7892` 的 HTTP 端口。未设置或留空时直连。只接受 HTTP/HTTPS 代理 URL；SOCKS、路径、查询参数和 fragment 会被固定安全错误拒绝。支持 URL 用户名/密码，但必须作为密钥保护，不要贴入日志或公开截图。

实现采用兼容 Node 22.15 的外部 Undici 7 `ProxyAgent`，仅显式注入 ChatGPT/Codex 出站 fetch：完成/SSE、模型发现、健康检查、配额/重置额度、OAuth 换码和刷新。不设置全局 dispatcher，不依赖 `NODE_USE_ENV_PROXY`，不代理本地 Hono 请求、OAuth 本地回调或浏览器导航；app dispose 时关闭 dispatcher。代理 URL 不进入日志、Admin API 或 DOM。Docker 中的 loopback 指容器自身，需要改用容器可达的宿主地址（如 Docker Desktop 的 `host.docker.internal`）。

## 日志与计时边界

HTTP access log 只挂在 `/v1/*` 和 `/admin/api/*`。默认 `ACCESS_LOG_FORMAT=text` 输出对齐的双箭头行：请求开始时 `[...] <-- METHOD path`，响应就绪时 `[...] --> STATUS [STREAMING] | duration | METHOD path?query`；SSE 不读取、clone 或延迟 body。text 模式避免流生命周期噪声，只在流清理后输出一次真实终态：`STREAM DONE`、`STREAM CANCELLED` 或 `STREAM FAILED`，携带累计 counts/bytes/duration。`simple` 是 `text` 的兼容别名。`detailed`/`json` 可保留安全结构化字段、首次 `STREAM START` 生命周期和终态；不再按固定时间输出 `STREAM ACTIVE`。所有格式只记录已规范化路径、查询参数名称及安全元数据，绝不记录 prompt、工具参数/结果、原始 provider payload、header、token、cookie、会话或代理凭据。

```text
[2026-09-08 13:12:03] [c6a432ed] [INFO ] [  api  ] <-- POST /v1/messages?beta
[2026-09-08 13:12:08] [c6a432ed] [INFO ] [ opus  ] --> 200 STREAMING | 4.681s | POST /v1/messages?beta
[2026-09-08 13:12:21] [c6a432ed] [ERROR] [ opus  ] --> STREAM FAILED | 17.598s | events=42 bytes=8192 | invalid_response
```

文本使用主机本地完整日期时间 `YYYY-MM-DD HH:mm:ss`；JSON 时间仍为 ISO UTC。固定列依次为时间、服务端 UUID 前 8 位、5 字符大写等级、居中的 7 字符 model/类别、箭头。model 先清理控制字符再截断；未知 model 时按规范化 path 显示类别：`/v1/*` 为 `api`、`/admin/*` 为 `admin`、其他为 `system`。耗时以秒表示并保留三位小数；两个方向都包含安全 query 类别（`beta` / `other`，不含值）。文本不含源码文件名或 IP；结构化 peer IP 仅来自连接，不信任转发头。

三个协议保留现有 readiness barrier：有效上游帧通过校验后才发送 SSE 200/prelude；该 200 表示响应就绪，不保证最终成功。普通请求使用 `durationKind: response_ready`。流在清理后恰好确定一个终态；默认 text 终态为 `STREAM DONE`、`STREAM CANCELLED` 或安全的 `STREAM FAILED`，且每个流恰好一次；都只包含 duration/events/bytes 和 allowlist 错误码/诊断。detailed/JSON 保留成功、失败、取消终态及完整安全指标，`durationKind: stream_terminal` 的耗时从请求进入开始（包含账号等待）。headers 发出后的失败仍保留 HTTP 200。`invalid_response` 的 detailed/JSON 诊断仅包含固定 allowlist 的 `protocolStage` / `protocolReason`，区分 SSE JSON、lifecycle/text/part/output item、incomplete、缺失成功终态、工具收尾和 replay snapshot；不记录 provider message/detail/原始 param 或 payload。EOF/`[DONE]` 不等于成功，custom backend 的 done 省略 `terminalSuccessful` 仍兼容，仅显式 false 被拒绝。静默上游期间默认每 15 秒发送 `: keepalive` SSE 注释（`SSE_KEEPALIVE_INTERVAL_MS=0` 可关闭），成功终态、取消或错误会停止 keepalive。实际客户端断开会静默关闭 HTTP body、取消上游并释放账号，不产生新的 AbortError 写入栈；内部 teardown abort 不作为客户端取消证据。上游 AbortError、超时和协议错误仍计为失败。响应前取消保留 499（账号获取期间仍为原有 503）。日志/统计异常不能阻止账号释放；middleware 不读取、clone 或 tee body。

Claude 终态结构只增加数字/boolean 指标：`sourceMessageCount` 为 messages 长度，`sourceContentBlockCount` 为 messages 中内容块总数（string 算 1，system 不计入这两项）；`upstreamBodyBytes` 为最终唯一一次 JSON.stringify 的 UTF-8 精确字节；`toolCount` / `toolSchemaBytes` 为最终工具数量 / schema JSON UTF-8 字节总和；`upstreamInputItemCount`、`replayItemCount`、`replayApplied` 描述实际发送输入和 replay。system、history、工具参数、图像、密文均计入 wire 总字节，但不记录内容。字段由内部 callback 回传并经过日志 allowlist，客户端同名字段不能注入。fetch 前就计算 wire 指标，因此超时/失败仍有已知规模。detailed 显示 wire 字节等关键项，JSON metadata 保留完整指标。

后台运营统计与 access log 独立；in-flight 不持久化，重启恢复为 0。`/metrics` 需要与 Admin API 相同的 API Key 或本地 Admin session，返回有界 request log 聚合及配置运营状态时的账号/请求/token 总计。未安装 access middleware 的独立路由保留安全 terminal 应用事件作为兼容回退。

请求 release 时，`unauthorized` 保持 unhealthy，需成功健康检查或重新授权恢复；`rate_limited` 保持 cooldown。`network_error`、`timeout`、`upstream_error`、`invalid_response` 仅保留固定本地诊断和安全错误码，原本健康的账号释放后仍 available、可立即重新获取。`invalid_request` 属于请求级错误，会清除临时诊断而不污染健康。成功或请求级错误 release 不会覆盖并发请求已设置的 unhealthy/cooldown。显式健康检查失败仍可能设为 error。

### 并发等待与安全失败原因

三个完成协议（Messages、Chat Completions、Responses）都在符合 provider、capability、模型和控制项的账号仅因并发已满而不可用时等待释放通知，不轮询。`ACCOUNT_ACQUIRE_TIMEOUT_MS` 默认 `30000`，`0` 表示立即失败；有效范围为 `0..2147483647` 整数毫秒，非法值会阻止启动。通知不会重置等待期限；客户端 AbortSignal 取消会清理等待者、定时器和监听器。其他不可用状态立即失败，不等待冷却结束或健康恢复。

| reason | 含义 |
| --- | --- |
| `no_account` | 没有匹配 provider 的账号 |
| `capability_unavailable` | 账号不具备所需 capability |
| `model_or_controls_unsupported` | 没有账号支持请求的模型/控制项 |
| `account_disabled` | 匹配账号均停用 |
| `account_unhealthy` | 匹配的启用账号均处于 unhealthy（如凭据未授权） |
| `account_error` | 排除 unhealthy 后，剩余匹配账号均处于 error（如手动健康检查失败） |
| `account_cooldown` | 剩余匹配账号处于冷却 |
| `account_busy` | 匹配的可用账号并发已满，且配置为立即失败 |
| `account_busy_timeout` | 等待并发槽位超时 |
| `request_aborted` | 获取账号期间客户端取消 |

原因仅用于内部调度和 access log，不加入 API/SSE 响应正文。获取失败仍使用原有 503/`overloaded_error` 和各协议错误外壳；已断开的客户端可能无法收到响应。Admin 中的 `maxConcurrency` 仍是账号并发上限，等待不会绕过它。SSE response-ready 的 200 **不会释放槽位**，释放仍由生成器 `finally` 在流完成、错误或取消清理时执行；日志耗时包含获取账号等待和 SSE 迭代器运行至终态的全部时间。详细说明见中英文使用指南。

## 环境变量

常用配置：

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

Session 生成不再使用 OAuth 短请求总时限。`CHATGPT_REQUEST_TIMEOUT_MS` 默认 60000，仅用于 OAuth/token/discovery/配额等短操作。`CHATGPT_RESPONSE_HEADER_TIMEOUT_MS` 默认 60000，限制 fetch 到 headers；`CHATGPT_STREAM_IDLE_TIMEOUT_MS` 默认 300000，从 headers 后等待首个非空 raw body chunk，之后每个非空 chunk 都续期（reasoning、tool、SSE comment、拆分帧均算活动，空 chunk 不算）。`CHATGPT_STREAM_TOTAL_TIMEOUT_MS` 默认 0，明确关闭绝对生成上限；大于 0 时从 fetch 开始计时，即使流活跃也终止。headers、bootstrap、idle 须为 1..2147483647 整数，总上限允许 0；非法配置拒绝启动。超时仍是 backend code=timeout/status=504，安全 timeoutKind 为 response_headers / stream_bootstrap / stream_idle / stream_total；调用方取消优先，不计账号失败。reader.cancel 清理最多等待 250ms。

`CHATGPT_STREAM_BOOTSTRAP_TIMEOUT_MS` 默认 60000，从成功 HTTP headers 开始，到首个完整且结构有效的受支持 Responses SSE frame 为止，是不随 heartbeat/raw chunk 续期的绝对期限。comment、heartbeat、未知扩展、半帧和单独 `[DONE]` 不会开启 gate；bootstrap 输入最多 8 MiB、256 个数据/命名事件帧。created、in_progress、reasoning/tool progress、text/tool 或合法 completed-first 均可开启 gate，且首帧的 replay/tool 校验全部成功后才发布内部 `upstream_ready`。该内部事件不会下发、计入 usage 或 replay。

三个流式端点均在 upstream ready 后才返回 HTTP 200，不以本地 SSE prelude 作为 readiness。ready 前的上游 HTTP 400–599 错误尽量保留原状态码并返回固定安全 JSON；无效首帧/空流为 502，超时为 504，调用方取消在连接可写时为 499。ready 后失败保持 HTTP 200 并发送对应协议的 SSE error terminal。此 gate 不改变 `/v1/responses` 正文 mapper 缓冲至 terminal 的行为，正文增量转发仍是独立改进。

包 API 迁移：旧 `timeoutMs` 单独使用仍保留绝对总时限和短操作时限；它已 deprecated。传入任一新字段即启用新分阶段语义，未指定总上限默认为 0；`requestTimeoutMs` 只管短操作。API app 显式传入所有新字段，不把旧环境变量当作生成上限。

`CHATGPT_BASE_URL` 只控制 session backend 的上游地址，不是客户端调用本项目的 Base URL。生产或非 loopback 部署前请显式设置 `API_KEYS`，并自行提供网络层访问控制。

## 文档

- [中文使用指南](docs/USAGE.zh-CN.md)
- [English usage guide](docs/USAGE.en.md)
- [协议兼容性说明](docs/protocol-compatibility.md)

## 验证

```bash
corepack pnpm test
corepack pnpm build
corepack pnpm typecheck
```

## 技术栈

- pnpm workspace monorepo
- TypeScript strict mode
- Hono HTTP API
- Vitest
- Docker / docker-compose 基础运行配置
