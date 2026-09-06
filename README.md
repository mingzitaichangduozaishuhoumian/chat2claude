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
6. **管理访问（Admin Access）**：查看本机 HttpOnly 管理会话；专业模式提供远程/自动化使用的 Admin API Key fallback。

控制台默认是简洁模式。专业模式额外显示内部/上游 ID、并发、冷却、安全错误码、发现诊断、完整动态模型、推理/服务层级选项、自定义 alias、手动 session 导入和 Admin API Key fallback。简洁/专业模式偏好保存在当前浏览器的 `localStorage.adminViewMode`；语言偏好保存在 `localStorage.adminLocale`。服务端不把这些 UI 偏好写入 runtime state。

管理页面默认简体中文，也可切换 English。切换会原地翻译页面文本、ARIA 属性、日期和数字，并在刷新后沿用当前浏览器选择；账号标签、provider 返回的模型名称等动态值不被擅自翻译。

## 认证与密钥

- `/v1/*` 使用 Runtime API Key 或预配置的 `API_KEYS`，使用 `x-api-key: <key>` 或 `Authorization: Bearer <key>`。
- Admin API Key 是远程或自动化管理 `/admin/api/*` 的专用命名；当前服务端认证也会接受有效 Runtime API Key 或 `API_KEYS` 访问 `/admin/api/*`。因此实际部署中应把 Runtime Key 同样视为敏感的管理凭据，不能将两者当作安全隔离边界。
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

## 日志与计时边界

HTTP access log 只挂在 `/v1/*` 和 `/admin/api/*`。它记录 request ID、方法、归一化路径、查询参数类别、HTTP 状态、peer IP、已验证的模型 ID/stream 标志，以及 `durationMs`。它不读取或记录 request/response body，也不会记录 token、cookie、Authorization、API Key 或 OAuth 参数；未知路径和动态 ID 会被归一化，查询参数只保留 `beta` 或 `other` 类别。

`durationKind` 固定为 `response_ready`：普通请求表示响应已准备好；流式请求表示 SSE response 已创建，不表示整个响应体已经发送完成。后台“最近账号活动”和请求结果是累计运营统计，不是完整请求日志。请求统计保存成功、失败、取消、token 总量、最近请求时间和 in-flight 数量；in-flight 不会持久化，重启后恢复为 0。`/metrics` 只返回进程内请求计数。

## 环境变量

常用配置：

```bash
CHATGPT_BACKEND=session
CHATGPT_BASE_URL=https://chatgpt.com
CHATGPT_REQUEST_TIMEOUT_MS=60000
PORT=3000
HOST=127.0.0.1
API_KEYS=<admin-or-runtime-key>
DATA_DIR=./data
```

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
