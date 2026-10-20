# chatgpt-to-claude

**中文** | [English](README.en.md)

最新发布版：**0.2.1** · [下载](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/releases/latest) · [安装与升级](INSTALL.md) · [更新记录](CHANGELOG.md)

[![CI](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/actions/workflows/ci.yml)

本文说明当前源码分支。网页网关路由、模型分类折叠、图片型号防误绑和源码按需编译等改进尚未包含在 v0.2.1 安装包中；详见[未发布变更](CHANGELOG.md#unreleased)。使用这些改进请按下方源码步骤运行，已发布安装包本身无需编译。

`chatgpt-to-claude` 是一个 TypeScript + Hono 实现的本地兼容层：对外提供 Claude Messages、OpenAI Chat Completions、OpenAI Responses、Images、Models API 等接口，对内连接 mock、ChatGPT/Codex session 或独立部署的 ChatGPT 网页网关。

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

首次获取源码并进入项目目录：

```bash
git clone https://github.com/mingzitaichangduozaishuhoumian/chat2claude.git
cd chat2claude
```

Windows（PowerShell）：

```powershell
.\start.bat
```

Git Bash、Linux 或 macOS：

```bash
sh ./start.sh
```

手动安装、检查并启动：

```bash
corepack pnpm setup
corepack pnpm check
corepack pnpm start
```

`start` 只在首次启动、源码/编译配置/依赖变化或编译产物缺失、损坏时构建；普通重启会跳过 TypeScript 编译，直接启动一个 API 服务。`start.bat` / `start.sh` 同样生效，无需更换命令。`corepack pnpm build` 可强制重新构建，`corepack pnpm build --if-needed` 可单独检查并补齐构建而不启动服务。开发时使用 `corepack pnpm dev`，完成初始构建后监听 API 源码变化。

首次构建时的 `Scope: 5 of 6 workspace projects` 表示编译五个内部子包，不是启动五个服务。`check` 会执行完整构建、测试和类型检查，日常启动无需先运行它。

默认地址：

```text
http://127.0.0.1:3000
```

打开 Admin 控制台：

```text
http://127.0.0.1:3000/admin
```

`start.bat` / `start.sh` 默认使用 `session` 后端；直接运行 `corepack pnpm start` 且未设置 `CHATGPT_BACKEND` 时使用 `mock`。使用 ChatGPT/Codex session 时，在 `/admin` 完成账号授权、模型发现和 Runtime API Key 生成。

### 更新已有源码

先在服务窗口按 Ctrl+C 停止旧进程，保留 `apps/api/data/`（或自定义 `DATA_DIR`）、现有环境变量和加密密钥。在项目目录执行：

```bash
git pull --ff-only
corepack pnpm install --frozen-lockfile
```

然后按原有端口配置运行 `start.bat` 或 `sh ./start.sh`。启动器会自动判断是否需要重新编译；升级发布包的方法见[安装与升级](INSTALL.md)。

### 自定义端口和监听地址

默认端口是 `3000`。如果该端口被占用，或你想同时运行多个实例，可以设置 `PORT`。

Git Bash、Linux 或 macOS：

```bash
PORT=3100 sh ./start.sh
```

PowerShell：

```powershell
$env:PORT = "3100"
.\start.bat
```

CMD：

```bat
set "PORT=3100"
start.bat
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
2. **账号与授权**：运行 Codex OAuth、检查账号健康与模型、重新授权、启用/停用、编辑或删除账号。文本模型、图片模型分类计数并默认折叠，展开后显示紧凑的型号标签。
3. **模型映射**：先开启或关闭 ChatGPT 网页，再选择自动或手动模式，配置网页网关；选择、启用并保存文本 alias。图片目录、内置 alias 帮助和调用说明默认折叠。专业模式可设置推理、服务层级并管理自定义 alias。
4. **API 接入**：生成、命名、复制、列出和撤销 Runtime API Key；查看 Base URL、endpoint 和动态 curl 示例。
5. **配额**：读取 provider allowance 缓存，刷新单个账号或全部账号，并区分 fresh、stale、error、unknown 状态。
6. **管理访问**：默认使用本机 HttpOnly 管理会话；专业模式在操作者自行让服务可达后提供 Admin API Key fallback。

控制台默认是简洁模式，两种模式都能展开文本和图片目录。专业模式增加可折叠的**账号诊断**与**上下文窗口详情**，以及 reasoning/service-tier 控制项、自定义 alias、手动 session 导入和 Admin API Key fallback。诊断和长说明按需展开，图片接口地址在每个分组中只显示一次。

### 网页网关与上游选择

这里的“网页”指登录 [chatgpt.com](https://chatgpt.com) 后的普通 **Chat 对话页**。独立的网页转 API 网关负责浏览器、网页登录和网页会话，本项目主 API 调用它的兼容接口；未接入 ChatGPT Work。下方辅助命令可准备本机网关，并打开独立 Chrome 供本人手动登录。

| 使用目的 | 模式与执行位置 |
| --- | --- |
| 让网页作为现有客户端的模型 API | 选择 **聊天**；工程文件、命令与工具由本地客户端执行，这是本集成的方式。 |
| 让网页自己使用文件、插件和工具交付任务 | 选择 **工作**；这是 [ChatGPT Work 的执行方式](https://learn.chatgpt.com/docs/get-started-with-work)，当前网关未接入该执行器。 |

若要严格限制本服务直接调用 Codex，使用**手动网页模式**；不兼容或不可用时返回错误。只有接受请求可能被选到 Codex 时，才使用 **Auto**。这里是请求路线选择，不是额外额度的保证。

可使用下方本机安装命令，或参考 [aurorax-neo/chat2api](https://github.com/aurorax-neo/chat2api) 和 [stufently/gpt-web-gateway](https://github.com/stufently/gpt-web-gateway) 自行部署。完成普通 Chat 登录后，可在 `/admin` → **模型映射** → **上游选择** 填写地址、可选 API Key 和实际支持的模型 slug，简洁模式即可配置。生成请求只需 OpenAI Chat Completions，不依赖 `/v1/models`；但管理 API 的网页健康检查会请求该接口，缺失时检查失败。模型 ID 原样使用，默认 `auto` 只声明该模型。

| 参考实现与本地补丁 | 对接建议与验证范围 |
| --- | --- |
| [aurorax-neo/chat2api，dbf6bf3](https://github.com/aurorax-neo/chat2api/tree/dbf6bf39686348449c25de3b6131ca733f448deb) | 普通聊天走网页 conversation 接口。图片使用内联 base64，暂不使用远程 HTTPS 图片 URL；工具调用由文本协议适配。其图片生成还有 Codex 分支，不能将该项目的所有调用都视为普通 Chat。 |
| [stufently/gpt-web-gateway，893f553](https://github.com/stufently/gpt-web-gateway/tree/893f553be358210a5c045aa9f62b56ba1edc5c78) | 真浏览器驱动普通 Chat，适合文本/SSE。聊天接口忽略图片和 model 参数，不提供原生工具及 `/v1/models`；请保持图片、工具开关关闭，使用 `auto`，不要用网页健康检查判断其聊天接口是否可用。 |
| [本仓库固定版本与本地补丁](integrations/gpt-web-gateway/README.md) | 在同一固定上游 SHA 应用图片及工具文本协议补丁：聊天 JSON/SSE 可保留多轮 user 图片，返回标准工具调用供客户端执行；没有 `/v1/models`，model 仍被忽略。2026-10-20，同一普通 Chat 账号在 Instant 档已通过两张 PNG 的历史接续、标准工具调用和模拟客户端工具结果 SSE 验证；Codex 源为合成替身。 |

两个项目对 `max_tokens`、采样参数和停止条件的执行都不能视为官方 API 的硬约束。

源码版可安装本机独立网关，需要 Git、npm 和已安装的 Google Chrome：

```bash
corepack pnpm web-gateway:setup
corepack pnpm web-gateway:login
corepack pnpm web-gateway:status
corepack pnpm web-gateway:start
```

`login` 打开独立 Chrome 供本人完成普通 Chat 登录；`start` 在当前终端持续运行，默认仅监听 `127.0.0.1:3101`。本机启动器强制所有聊天请求在发送前确认普通 Chat 模式，检测到 Work 或无法辨识页面时拒绝发送。

本机启动器还强制 `CHAT2CLAUDE_MAX_THINKING=true`：每次在普通 Chat 中选择当前账号已识别菜单或滑杆提供的最高思考档位，读回确认，并在发送前再次验证。最高档禁用或无法确认时拒发，不静默退回 Instant 或较低档位；选档也不能切入 Work。这是独立网关的本机运行策略，不代表通用网页适配层支持任意 `reasoning_effort`，`model` 仍由该网关忽略，配置继续使用 `auto`。2026-10-20，当前账号已通过 Pro 档单 PNG 识图及工具请求的 JSON 验证；此结果不覆盖 Pro SSE、多图或工具结果往返。

这里的 **Pro 是普通 Chat 界面的档位名称**，不表示选择了某个 Codex 模型，也不能等同 Codex 的 `max`、`xhigh` 或 `ultra`。本集成确认的是网页可读回的最高档位。

另开终端启动主项目后执行：

```bash
corepack pnpm web-gateway:connect -- --api-url http://127.0.0.1:3000
```

`--api-url` 改成主服务实际的本机根地址。此命令保存随机网关 Key，开启**手动网页模式**并配置 `auto`、`sonnet=auto`、图片输入、工具调用和可见上下文接续；会更新已有网页路由配置。要自动选择或停用网页，可继续在管理台修改。默认安装与登录数据位于已忽略的 `apps/api/data/web-gateway/`；自定义 `--directory PATH` 时须自行排除版本控制，所有后续命令使用相同目录。安装固定提交 `893f553be358210a5c045aa9f62b56ba1edc5c78` 及仓库补丁，不自动跟随上游更新。详见[安装、私密数据与限制](integrations/gpt-web-gateway/README.md)。

本补丁接受 user 消息及其历史中的规范 Base64 PNG/JPEG/WebP/GIF 图片，整段请求累计最多 10 张、解码图片累计最多 10 MiB、整个 JSON 最多 16 MiB；保留图片与所属消息的对应关系。远程 URL、非 user 图片、未知非文本块和非法编码返回 400。工具使用受校验的文本协议，JSON/SSE 返回标准 `tool_calls`，由客户端执行；`strict:true` 不受支持。独立网关原生 `/v1/responses` 仍拒绝图片和工具；主服务 Responses 通过 Chat Completions 适配，不受此原生端点限制。通用自动选择不能预判所有网关限制，HTTPS 图片或超限请求仍可能选中网页后收到 400，发送后不转 Codex。

先用 **使用 ChatGPT 网页** 开关决定网页是否参与，再选择 **自动模式 / 手动模式**。关闭网页（或预置 `CHATGPT_WEB_ENABLED=false`）时仅使用 Codex，保留网关、Key、映射和模式选择，重新开启即可恢复；此开关优先于自动路由和请求头覆盖，`web` 请求头在关闭时会被拒绝。清除配置仍需点击独立的 **清除网页配置**。

**自动选择** 默认网页优先，可在管理台改为 Codex 优先；先匹配模型、图片/工具等能力和可用性，网页不满足时才考虑兼容的 Codex。手动 **Codex / ChatGPT 网页** 严格限定上游；如需完全禁止 Codex 回退，请选择 **ChatGPT 网页**。请求发送后不跨后端重试。单次请求用 `x-chat2claude-backend: auto|codex|web` 覆盖，成功响应的同名 header 标明实际使用的 `codex` 或 `web`。默认保留会话的账号及 provider 绑定；可显式开启下方的可见上下文接续。

**网页模型映射** 可选，每行填写 `客户端模型或 alias=网页模型 ID`，例如 `sonnet=auto`、`opus=auto`。这会明确将对应请求改用网页 `auto`，即使该 alias 原来绑定 Codex 型号；不声明两种型号等价。目标必须是网关配置的模型 ID；未映射时仍按真实型号匹配。留空保存可清除映射。

网页能力以适配声明为准：仅确认网关支持后才勾选 **工具调用** 或 **图片输入**。通用适配层可透传用户消息中的 HTTPS 图片 URL 或 PNG/JPEG/WebP/GIF base64 图片，整个序列化请求最多 16 MiB；具体网关可施加更严格限制，本仓库补丁的图片必须内联 Base64。工具结果图片、网页图片生成和编辑尚未接入。是否能识图由网关与网页模型决定。本地补丁通过工具文本协议让网页返回工具请求，Claude Code 等客户端负责读写工程文件和执行命令；网关本身不执行工具。每次请求选择一个后端，不默认执行“网页规划 → Codex 执行 → 网页复核”，以免增加调用。当前网页适配不支持原生 reasoning replay、推理强度、服务档位或结构化输出；这些请求不会静默降级。

**同一工程的上下文接续**：在管理台启用 `contextHandoff`，或预置 `CHATGPT_CONTEXT_HANDOFF=true`。此开关默认关闭，辅助 `web-gateway:connect` 会主动开启。开启后，Responses 可通过 `previous_response_id` 在 Codex/网页或明确改变模型时接续同一 API 用户已保存的可见历史；Messages/Chat 的已完成工具循环可传递公开工具 ID、原始参数及结果。只共享已知可见内容，剥离私有 reasoning、原生消息 ID；未完成工具及未知原生块不能跨后端接续。同 provider、同模型继续保持原账号绑定。

请继续使用同一个客户端工程及本地工具执行器，并在请求中携带必要的完整历史。Responses 历史默认在内存保留 30 分钟，隐式 reasoning replay 默认 10 分钟，均按 API 用户隔离并受容量限制，服务重启后失效。此功能不会同步 ChatGPT Projects，也不会挂载项目目录或自动读取文件；文件内容、修改结果和测试证据仍由客户端工具回传。共享目录本身不能代替这些上下文。

**额度说明**：目标是优先使用普通 Chat，减少本服务直接发往 Codex 后端的请求。普通 Chat 的限额与 Codex 的关系以实际套餐、模型和账号页面为准；本项目不使用 ChatGPT Work 的规则推断普通 Chat 是否共享额度，也不保证增加总额度。实际调用来源可从响应 header 和管理台查看；还应确认网关内部确实使用普通 Chat，而非转发回 Codex。

2026-10-20 核对的[官方定价说明](https://learn.chatgpt.com/docs/pricing)明确规定 **Work 与 Codex 共享用量、额度和价格规则**。这不能反推出普通 Chat 一定有独立额度。判断是否更耐用，需要同一账号及工作区、同一计量窗口的细粒度用量对照；一次请求后整数百分比没变化，不构成“不扣 Codex 额度”的证据。

**本轮真实验证（2026-10-20，Pro 档）**：同一个手动登录的普通 Chat 账号直连已安装网关的 Chat Completions JSON，使用固定数字 73 的单 PNG。选档后和发送前均确认 Pro；HTTP 200，`applied.thinking_mode=pro`，`thinking_verified`、`requested_verified` 均为 `true`，`thinking_fallback=null`，已确认附件数为 1。普通识图正确返回 73；指定单次 `record_digits` 工具请求返回标准 `tool_calls`，参数 `digits` 为字符串 `"73"`。该工具请求的只读观测确认一次 conversation POST、一个图片附件及一个多模态图片部分。没有实际执行客户端工具、调用 Codex 或向 3000 主服务发送生成请求。此结果不覆盖 Pro SSE、多图或完整工具结果往返。

**此前真实验证（2026-10-20，Instant 档）**：同一普通 Chat 账号通过测试实例的 Responses 历史接续，正确识别旧图 73、当前图 29，并返回保留项目代号的标准工具参数；合成 Codex 源仅调用一次替身，未调用真实 Codex，私有 reasoning 和原生消息 ID 未传入网页。将真实调用 ID 配对模拟客户端工具结果后，完整双图历史的 Messages SSE 返回 HTTP 200、backend=web、完整 `message_stop`，代号、数字与回执正确。没有实际执行文件或命令工具；运行中的 3000 主服务仅配置接入，生成验证使用内存测试实例。此结果限一个账号和两张 PNG，不证明最高思考档、其他格式、长期可靠性或额度关系。2026-10-19 的单 PNG JSON/SSE 结果继续保留；完整记录见[集成记录](integrations/gpt-web-gateway/README.md#验证记录与复现)。

管理台填写的网关 API Key 仅保存在服务端现有 `runtime-state.json`，可用 `STATE_ENCRYPTION_KEY` 加密；不会由 GET 返回或保存到浏览器存储。Key 留空保留已保存值；**清除网页配置** 会移除配置和 Key，并切回 Codex。

### 文本与图片模型

| 类型 | 调用与映射 | 参数区别 |
| --- | --- | --- |
| 文本/代码模型 | 使用 alias 或文本型号调用 Messages、Chat Completions、Responses 接口 | 推理强度、服务层级按模型目录支持情况处理；页面窗口信息不代表客户端当前实际配置。 |
| 图片生成模型 | 直接使用图片型号调用 `POST /v1/images/generations`，无需创建文本 alias | 使用 `prompt`、`size`、`quality` 等图片参数；不接受文本推理强度、服务层级或上下文设置字段。 |

支持图片输入的对话模型不等于图片生成模型。Admin 会在保存时拒绝已知图片型号作为新文本 alias 或文本后端；历史误绑仍可禁用、解绑、修正或删除。

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

Admin 账号卡片分别显示文本模型与图片接口模型数量，例如 10 个文本模型、9 个图片接口项；其中包含 5 个基础型号和 4 个本地尺寸别名，计数不代表 OpenAI 全部图片型号。模型页在简洁和专业模式下都有独立、默认折叠的图片型号分组。基础型号为 `gpt-image-1.5`、`gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-2.5`，与 [CPA 的内置注册项](https://github.com/router-for-me/CLIProxyAPI/blob/8ef43e4df3b216a42493105d31c2873b69191473/internal/registry/model_definitions.go#L245)一致，原值透传。Flare 和 Sunburst 各增加 `-2k`、`-4k` 别名，默认请求 2048×2048、3840×2160；显式 `size` 优先。别名映射到基础型号，最终 PNG 按目标尺寸保留比例缩放及补边，属于本地插值处理，不能代表模型生成了更多原生细节。支持指定尺寸和 `background:transparent`，完整边界和示例见[图片生成说明](docs/USAGE.zh-CN.md#独立-gpt-image-生成)。2.5 的这些明确型号可使用 `xhigh`/`max` 质量。这些图片项来自独立的 `imageModels` 字段，不混入文本 `discoveredModels` 或 alias 候选，也不表示已验证账号的图片生成权限。

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

网页路由也可通过以下环境变量预置；未配置时保持 Codex 模式。后续可在管理台修改并持久化：

```bash
CHATGPT_ROUTING_MODE=auto
CHATGPT_AUTO_PREFERENCE=web
# 可见历史和已完成工具结果的跨后端接续默认关闭；不共享私有 reasoning 或同步 ChatGPT Projects
CHATGPT_CONTEXT_HANDOFF=false
# CHATGPT_WEB_ENABLED=false # 关闭网页但保留配置；优先于自动路由和请求头
CHATGPT_WEB_BASE_URL=http://127.0.0.1:8000
CHATGPT_WEB_MODELS=auto
CHATGPT_WEB_SUPPORTS_TOOLS=false
# 本机网关补丁设为 false，发送前排除 strict:true 工具；省略保留旧网关透传行为
# CHATGPT_WEB_SUPPORTS_STRICT_TOOLS=false
CHATGPT_WEB_SUPPORTS_IMAGES=false
# 可选：将客户端模型或 alias 明确改用网页型号；目标须列在 CHATGPT_WEB_MODELS 中
# CHATGPT_WEB_MODEL_MAPPINGS={"sonnet":"auto","opus":"auto"}
# CHATGPT_WEB_API_KEY=<gateway-api-key>
```

模型目录可能受请求客户端版本控制。如果刷新成功却缺少新模型，请升级服务，并在专业模式检查 discovery 诊断中的 `clientVersion`。当前兼容基线为 `0.160.0`；可用 `CODEX_CLIENT_VERSION` 显式覆盖，旧环境变量也会覆盖更新后的默认值。修改版本后需重启服务并刷新账号模型。

## 持久化与安全

上述源码启动命令默认使用 `apps/api/data/`；发布包默认使用解压目录下的 `data/`。可以用 `DATA_DIR` 修改，相对路径分别基于 API 子目录和发布包根目录解析。runtime state 保存账号 session、Runtime API Key、alias overlay 和网页上游配置；operational state 保存净化后的管理统计、discovery/cache、quota cache 和诊断信息。

源码启动读取进程环境变量；发布包启动器还会读取包根目录的 `.env`，已有环境变量优先。迁移时保留原数据目录和 `STATE_ENCRYPTION_KEY`，具体步骤见[安装与升级](INSTALL.md)。

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

更新依赖后，还可以运行 `corepack pnpm audit` 检查锁文件中的已知安全公告。`test` 包含 Vitest 4 / Vite 6 用例与 Node.js 原生构建缓存测试。

GitHub Actions 已启用，可查看 [CI 状态](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/actions/workflows/ci.yml)和[打包运行记录](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/actions/workflows/release.yml)：

- `main` 推送、Pull Request 和手动 CI 运行会检查 Windows/Linux × Node.js 22.15.0/24；Linux Node 24 还执行依赖审计、打包和解包运行检查。
- 发布前同步更新六个 `package.json` 的版本及 `CHANGELOG.md`。匹配版本的 `v*` 标签触发自动发布，只有 Linux 构建验证和同批软件包的 Windows 内置运行时检查都通过后，才上传资产并公开版本；同名资产不会被覆盖。
- 手动运行 **Release packages** 只构建并验证安装包，产物保留在 Actions 工件中，不创建或更新 Release。

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
