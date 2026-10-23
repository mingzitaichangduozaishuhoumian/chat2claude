# Changelog / 更新记录

## Unreleased

暂无未发布变更。 / No unreleased changes.

## 0.3.1 — 2026-10-23

### 中文

- 网页后端改为明确手动开启。新配置和没有启用字段的旧配置默认仅用 Codex；保存网关地址或运行 `web-gateway:connect` 都不会开启网页、切换模式或开启上下文接续。已明确保存的开启状态继续保留，Auto 缺省优先 Codex。
- 上游面板显示服务端确认的“当前生效”策略，未保存修改单独提示。网页关闭时隐藏模式控件；网关配置可独立展开、保存和检查，操作按钮与结果放在面板上方。
- 新增不发送消息的连接检查，区分未配置、未检查、认证失败、未就绪、不可连接、超时及异常响应。`/v1/models` 缺失时回退 `/health`，最多 5 秒；连接成功不等于已登录或可生成。已保存配置和上次请求失败分别展示，网页 API 错误会明确提示检查启动、地址、Key、网页登录或切回 Codex。

### English

- Require an explicit Web opt-in. New configurations and legacy configurations without an enable flag use only Codex by default. Saving a gateway or running `web-gateway:connect` does not enable Web, switch modes or enable context handoff. Existing explicit enablement is retained; Auto defaults to Codex preference.
- Show the server-confirmed effective routing separately from unsaved changes. Hide mode controls when Web is off, allow gateway configuration and checks independently, and keep actions and feedback near the top of the panel.
- Add non-generating connection checks with actionable configuration, authentication, readiness, connectivity, timeout and response feedback. A missing `/v1/models` falls back to `/health` within a five-second deadline. Connectivity does not establish web login or generation readiness. Recent request failures remain separate, and Web-specific API errors explain how to check the gateway or switch to Codex.

## 0.3.0 — 2026-10-20

本版本将普通 Chat 网页适配、上游选择、可见上下文接续和 2K／4K 图片尺寸别名纳入正式安装包。提供 Windows x64 免安装 ZIP、通用 Node ZIP／TAR.GZ、SHA-256 校验文件与版本来源清单。浏览器网关需独立部署并登录；源码版的网关辅助命令、补丁和 Chrome 不随便携包分发。

This release packages ordinary-Chat gateway integration, upstream selection, visible-context handoff and local 2K/4K image size aliases. Downloads include a Windows x64 portable ZIP, universal Node ZIP/TAR.GZ, SHA-256 checksums and a source manifest. Deploy and sign in to the browser gateway separately; source helper commands, patches and Chrome are not bundled.

### 中文

- 为 Flare／Sunburst 增加四个精确的本地 `-2k`／`-4k` 尺寸别名，图片目录共九项，显示基础型号、默认尺寸与本地处理标记。别名映射到原基础型号，默认 2048×2048／3840×2160，显式尺寸和 `auto` 优先；最终 PNG 使用保留 alpha 的比例插值与居中补边，返回实际像素，转换失败或超预算明确报错。基础型号继续原样交付，保留透明背景和 2.5 高级质量支持。2026-10-20，一个账号通过 Flare-2k 的 low/n=1/opaque JSON 及 Sunburst-4k 的 low/n=1/transparent 最终 SSE 实测，均 HTTP 200；交付 PNG 为 2048×2048 和 3840×2160，尺寸元数据一致，分别约 15.0／19.9 秒。4K 交付图含透明像素；探针未记录处理前源图，不证明上游原生尺寸、透明度或额外细节。其他别名、质量、批量和账号仍以合成兼容测试为主；本次不包含绘图工作台。
- 本机独立网页网关启动器强制 `CHAT2CLAUDE_MAX_THINKING=true`，每次从当前账号已识别的普通 Chat 菜单或滑杆选择最高思考档，读回确认并在发送前再次验证；最高档禁用或无法确认时拒发，不静默退 Instant、较低档或切入 Work。这是本机 runner 策略，通用 Web 适配仍不支持任意 `reasoning_effort`，网关忽略 `model`、继续配置 `auto`。2026-10-20，同一普通 Chat 账号已通过 Pro 档单 PNG 识图和工具请求 JSON：两者 HTTP 200，档位及请求均验证为 Pro、无降档，识别 73 并返回 `record_digits` 的字符串 `"73"` 参数；无 Codex 或真实客户端工具执行。Pro SSE、多图及工具结果完整往返尚未实测，此前双图和结果循环仍属于 Instant 历史验证。修复 `aria-current="false"` 被误认成激活状态，仅认可已知正值。
- 仅将锁文件中的传递依赖 `source-map-js` 从 `1.2.1` 升至 `1.2.2`，修复 [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) 的事件循环拒绝服务风险；不升级 Vite/PostCSS 或增加 override。修复后锁定安装、`pnpm audit --audit-level high`、全工作区构建及类型检查通过。
- 增加本机普通 Chat 网关的 `web-gateway:setup/login/start/status/connect` 命令，固定 `stufently/gpt-web-gateway` 提交 `893f553be358210a5c045aa9f62b56ba1edc5c78` 并应用本地补丁。独立 Chrome 由本人手动登录，默认私密安装目录由 Git 忽略；connect 保存随机 Key，选择手动网页模式并开启图片、工具和可见上下文接续。聊天 JSON/SSE 支持 user 历史图片，全请求累计最多 10 张、解码图片 10 MiB、JSON 16 MiB；拒绝远程 URL、非 user 图片和非法编码，发送后不自动重试。独立网关原生 Responses 仍拒绝图片和工具。
- 网页网关新增受校验的工具文本协议，返回标准 JSON/SSE `tool_calls`，由客户端执行文件及命令工具，网关不执行。最多 128 个 function 定义、工具名 1–64 字符、新输出最多 8 个调用（禁并行时 1 个）、每条 assistant 历史最多 128 个完整配对调用、单项参数 1 MiB；保留原始参数和数值字面量，明确拒绝 `strict:true`。
- 新增 `contextHandoff` 可见上下文接续开关，默认关闭，可用 `CHATGPT_CONTEXT_HANDOFF` 预置。启用后同一 API 用户可跨 Codex/网页或明确换模型继续已保存的可见历史及完成工具循环；不跨传私有 reasoning、原生消息 ID、未知原生块或未完成工具。同 provider、同模型仍保留账号绑定。历史仅在有界内存中保留，过期或重启后需客户端完整历史；不共享 ChatGPT Projects 或挂载项目文件。
- 兼容中文“聊天 / 工作”的 `aria-pressed` 和精确附件标签；每次图片请求使用唯一 UUID 文件名避免网页自动重命名。启动器对所有聊天强制普通 Chat 严格检查，未知页面拒发，严格新会话最多等待 60 秒输入框。无 `conversationId` 且未开启 `reuseChat` 的独立图片请求新建当前槽位页面并完整初始化，修复旧页导航后的附件不稳定，不影响其他槽位或显式会话复用。本轮已安装补丁的 `test:vision` 通过 11 组解析/HTTP、18 项工具协议和 100 项 Node 测试（最高档 26、附件/文本模式 72、关闭流程 2）；完整主仓 `pnpm check` 通过构建、2707 项 Vitest、build-cache 8、runner 19 和全部类型检查。
- 2026-10-20 较早的 Instant 档验证中，已安装补丁在同一次 `createApp` 内存实例运行中连续通过两轮真实网页请求（合成 Codex 源 1 次、真实 Web 2 次），两轮图片请求均新建本槽页面；同一普通 Chat 账号完成两张合成 PNG 的可见历史接续及工具往返：Responses 从一次合成 Codex 调用接续真实网页，正确返回代号及旧图 73、当前图 29 的标准工具参数，私有 reasoning 和原生消息 ID 未传入网页；真实调用 ID 配对模拟客户端结果后，完整双图历史的 Messages SSE 返回 HTTP 200、backend=web、完整 `message_stop` 及正确回执。没有调用真实 Codex 或执行文件命令；3000 主服务仅配置接入。保留 2026-10-19 单 PNG 的 JSON/SSE 历史结果，不据此承诺其他格式、账号、长期可靠性或额度。原生扩展不透传及 Windows 上游两项信号测试基线失败说明继续保留。
- 网页后端指登录 chatgpt.com 后的普通 Chat，通过独立网关接入；未接入 ChatGPT Work。补充开源网关的实际兼容差异、固定补丁的局部实测边界，并同步兼容清单。
- 上游选择改为先开启/关闭 ChatGPT 网页，再选择自动或手动模式；关闭后仅用 Codex，保留网页配置、Key、映射和模式选择，重新开启即可恢复。网页开关优先于自动路由及请求头覆盖。
- 接入独立部署并登录的 ChatGPT 网页网关；管理台可选自动、Codex 或网页，也可用 `x-chat2claude-backend` 按请求覆盖并查看实际后端。自动默认网页优先，可切换为 Codex 优先，按模型、能力和账号可用性匹配；发送后不跨后端重试，默认历史绑定账号与 provider，另可启用可见上下文接续。支持显式网页模型映射及图片输入/工具能力声明，凭据持久化并支持现有加密。纯网页模式可禁止 Codex 回退；每次请求只选一个后端，调用来源不等于额度节省。
- 账号模型按文本、图片分类计数并默认折叠，展开后使用紧凑型号标签；图片接口地址只显示一次。专业模式的账号诊断、上下文详情及模型页使用说明按需展开。
- 明确区分文本 alias 与图片生成接口；保存时拒绝已知图片型号作为新文本 alias 或后端目标，历史误绑仍可禁用、解绑、修正或删除。
- 源码启动改为按需编译：复用未变化的成功构建，源码、配置、依赖或产物变化时重建。保留强制构建命令，并提供 `build --if-needed` 预检。
- 启用 GitHub Actions CI 和标签自动发包；手动发包流程只生成验证工件，不发布或覆盖现有版本。
- 更新中英 README 的源码升级、分类界面、启动方式和源码版/安装包数据目录说明。

### English

- Added four exact local `-2k`/`-4k` aliases for Flare/Sunburst, bringing the image catalog to nine entries with base-model, default-size and local-processing metadata. Aliases map to their base ID and default to 2048×2048/3840×2160; explicit size and auto take precedence. Final PNGs use proportional interpolation and centered padding with alpha retained, report physical dimensions, and fail explicitly on processing errors or budgets. Base models retain their original output; transparent backgrounds and extended 2.5 qualities remain supported. On 2026-10-20, one account passed Flare-2k low/n=1/opaque JSON and Sunburst-4k low/n=1/transparent final SSE, both HTTP 200, delivering 2048×2048 and 3840×2160 PNGs with matching size metadata in about 15.0/19.9 seconds. The delivered 4K PNG contains transparent pixels; the probe did not capture the pre-processing source, so it does not establish native upstream dimensions, alpha or additional detail. Other aliases, qualities, batches and accounts still rely primarily on synthetic compatibility coverage. This update does not add a drawing studio.
- The separate local web-gateway runner forces `CHAT2CLAUDE_MAX_THINKING=true`, selecting the current account's highest recognized ordinary-Chat menu or slider level on every request, requiring read-back confirmation and rechecking before submission. A disabled or unconfirmed top level rejects the request without silently using Instant, a lower level or Work. This is a local-runner policy; the generic Web adapter still does not support arbitrary `reasoning_effort`, and the gateway ignores `model`, so keep `auto`. On 2026-10-20, the same ordinary Chat account passed Pro-level single-PNG recognition and tool-request JSON: both returned HTTP 200 with verified Pro and no fallback, recognizing 73 and returning a record_digits argument as the string "73". No Codex request or real client-tool execution occurred. Pro SSE, multiple images and a complete tool-result round trip remain untested; the earlier two-image/result-cycle checks remain Instant history. Fixed `aria-current="false"` counting as active by accepting only known positive tokens.
- Updated only the lockfile's transitive `source-map-js` from `1.2.1` to `1.2.2`, fixing the event-loop denial of service in [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), without upgrading Vite/PostCSS or adding an override. Frozen-lockfile installation, `pnpm audit --audit-level high`, workspace build and typechecking passed after the fix.
- Added local ordinary-Chat gateway setup/login/start/status/connect commands. Setup pins `stufently/gpt-web-gateway` commit `893f553be358210a5c045aa9f62b56ba1edc5c78` with the local patch. Sign in manually in a separate Chrome window; private installation data is ignored by Git. Connect saves a random Key, selects manual Web and enables images, tools and visible-context handoff. Chat JSON/SSE accepts user-image history within totals of 10 images, 10 MiB decoded and 16 MiB JSON; remote URLs, non-user images and malformed input are rejected, with no automatic resend after submission. Native gateway Responses still rejects images and tools.
- Added a validated tool text protocol returning standard JSON/SSE tool calls for the client to execute. The gateway executes no tools. Limits are 128 function definitions, 1–64 character names, 8 new calls or 1 without parallel calls, 128 fully paired calls per assistant history group and 1 MiB per argument string. Original strings and numeric tokens are preserved; strict:true is rejected.
- Added opt-in contextHandoff, default false and presettable through CHATGPT_CONTEXT_HANDOFF. The same API owner can continue stored visible history and completed tool cycles across Codex/Web or an explicit model change, without transferring private reasoning, native message IDs, unknown native items or incomplete tools. The same provider/model keeps account affinity. Bounded memory history expires and resets on restart; clients must retain full history. No ChatGPT Projects synchronization or project-file mount is provided.
- Added observed Chinese Chat/Work `aria-pressed` and exact attachment-label support. Unique UUID filenames avoid browser renaming collisions. The runner enforces strict ordinary Chat for every chat request, rejects unknown pages and waits up to 60 seconds for a new-chat composer. Independent image requests without conversationId or reuseChat create and fully initialize a new page in their own slot, fixing attachment instability after old-page navigation without affecting other slots or explicit session reuse. The current installed patch passed test:vision with 11 parser/HTTP groups, 18 tool-protocol tests and 100 Node tests (26 maximum-thinking, 72 attachment/text-mode, 2 shutdown). The complete main-repository pnpm check passed the build, 2707 Vitest tests, build-cache 8, runner 19 and all typechecks.
- Earlier on 2026-10-20 at Instant, the installed patch passed two consecutive real Web requests in one in-memory createApp run (1 synthetic Codex call, 2 real Web requests), each using a fresh page in its own slot. The run checked visible history and a tool round trip with two synthetic PNGs on one ordinary Chat account. Responses continued one synthetic Codex call on real Web and returned correct project-code and image-digit arguments (earlier 73, current 29), without forwarding private reasoning or native message IDs. The real call ID paired with a simulated client result then passed full-history Messages SSE: HTTP 200, backend web, complete message_stop and correct receipt. No real Codex request or file/command execution occurred; port 3000 was configured only. The historical 2026-10-19 single-PNG JSON/SSE results remain, without establishing other formats, accounts, long-term reliability or quotas. Unforwarded extensions and two upstream Windows signal-test baseline failures remain documented.
- Clarified that Web means ordinary Chat after signing in to chatgpt.com through a separate gateway, without a ChatGPT Work integration. Documented source-verified gateway compatibility differences and the pinned patch's limited live validation, and synchronized the compatibility manifest.
- Added a separate ChatGPT Web enable switch before Auto/Manual mode selection. Disabling Web uses only Codex and preserves gateway settings, Key, mappings, and mode selection for re-enabling. The switch takes precedence over Auto routing and request headers.
- Added separately deployed and authenticated ChatGPT web gateways. Choose Auto, Codex, or Web in Admin, or override per request with `x-chat2claude-backend`; the response reports the actual backend. Auto prefers Web by default, offers Prefer Codex, and matches models, capabilities, and availability. No cross-backend retry occurs after dispatch; history retains account/provider affinity by default, with visible handoff as an explicit option. Explicit web model mappings and image/tool capability declarations support existing credential persistence/encryption. Web-only mode prevents Codex fallback; each request selects one backend, and backend usage is not reported as quota savings.
- Grouped account models into collapsed text/image catalogs with compact model-ID labels and a single Images endpoint per group. Account diagnostics, context details, and model-page guidance expand on demand.
- Distinguished text aliases from image generation. Admin now rejects registered image IDs as new text aliases or backend targets while keeping legacy bindings repairable and removable.
- Added source build caching: reuse unchanged successful builds and rebuild when source, configuration, dependencies, or outputs change. Forced builds remain available; `build --if-needed` prepares the build without starting the service.
- Enabled GitHub Actions CI and tag-based releases. Manual packaging runs produce verification artifacts without publishing or overwriting releases.
- Updated both READMEs with source updates, grouped model controls, startup behavior, and source/package data-directory differences.

**功能验证 / Feature validation（2026-10-20，`6428eef`）：** [Windows/Linux × Node 22/24 CI](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/actions/runs/39414623639) 全部通过 / passed。正式发布流程在标签对应的干净提交上重新构建、测试、校验 SHA-256，并验证同批 Windows 内置运行时后上传 / The tag release workflow rebuilds and tests a clean checkout, verifies SHA-256 checksums and the same Windows runtime artifacts before uploading.

**历史验证 / Historical validation（2026-10-05，`cf88c77`）：** [Windows/Linux × Node 22/24 CI](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/actions/runs/37273614978) 全部通过 / passed；[自动打包试运行 / packaging dry run](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/actions/runs/37273646542) 完成 Linux 构建与同批 Windows 运行时验证 / passed Linux build and Windows runtime checks. 未执行发布步骤 / publication was skipped.

## 0.2.1 — 2026-10-04

### 中文

- 新增 Windows x64 免安装包（内置经官方校验的 Node.js 24 运行时）及通用 Node ZIP/TAR.GZ；包含编译产物和生产依赖，无需用户安装 pnpm 或构建。
- 提供发布包启动器、可选 `.env`、独立数据目录、版本来源清单和 SHA-256 校验文件；补充首次安装、源码版迁移和保留账号的升级说明。
- 完善贡献指南、安全报告、使用支持、社区行为约定、Issue 表单和 PR 模板；配置依赖更新，并启用仓库私密漏洞报告与依赖安全修复。
- 保留 0.2.0 的 API 和五型号图片支持。修正 README 对源码启动器和手动启动默认后端的说明。

### English

- Added a Windows x64 portable package with an officially verified Node.js 24 runtime, plus universal Node ZIP/TAR.GZ archives. Production dependencies and compiled application files are included.
- Added launchers, optional `.env` loading, an independent data directory, release provenance and SHA-256 checksums; documented installation, source migration and upgrades that retain account data.
- Added contribution, security, support and conduct guidance, issue forms and a pull-request template. Configured dependency updates and enabled private vulnerability reporting and dependency security fixes.
- Retained the 0.2.0 API and five image-model presets. Clarified the different backend defaults of source launchers and direct manual startup.

## 0.2.0 — 2026-10-04

### 中文

- 新增独立 `POST /v1/images/generations`，沿用已授权 ChatGPT 账号和 Codex Images 服务。内置 `gpt-image-1.5`、`gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-2.5`，默认仍为 `gpt-image-2`；全部 ID 原值透传。
- Admin 在简洁、专业两种模式下独立展示和计数图片接口模型；内置目录与 CPA 一致，不混入账号文本 discovery 或 alias，也不自动证明账号图片权限。模型发现的 Codex 客户端兼容基线更新为 `0.160.0`。
- 改进 Responses 流的图片预览与终态核对、SDK 事件顺序、拒绝内容和取消释放。图片使用独立预算：每项 16 MiB、每组 64 MiB、最多 10 张；文本和隐藏 replay 限额保持。
- 保留工具参数的大整数、高精度小数和原始 JSON；Claude 非流式输出也保持数值保真。修复工具结果图片与长历史转换，显式 Responses 输入历史支持 4096 项 / 8 MiB。上下文窗口使用上游元数据，缺失或账号间冲突不再伪造统一值。

**验证与边界：** 2026-10-04，在一个账号上对五个内置图片型号各请求一张，参数为 `quality:low`、`n:1`、`size:1024x1024`、`background:opaque`、`stream:true`。全部 HTTP 200、最终 `image_generation.completed` SSE 和 PNG 解码通过，每张约 13.4–15.5 秒。实际图片均为 **1254×1254**，原样交付，不能承诺精确请求尺寸、所有账号、更高质量档位或多图批次均已实测。

独立 Images SSE 只有最终图片，没有渐进预览；流式仅允许 `n=1`，`partial_images` 只能为 0 或省略。图片编辑、variations 和生成图隐式历史续聊仍不支持。Responses 的图片事件转换有合成测试覆盖，当前宿主的 Responses 图片工具不因此视为已真实验证。Chat/Claude 收到图片输出时明确报错。

v0.2.0 发布时，本地验证记录为 **2330 项测试通过，并通过 build / typecheck**；当时尚无该标签的 GitHub Actions 执行结果。后续 `main` 分支的云端验证记录见上方 0.3.0，不追溯视为本标签的 CI 验证。

### English

- Added standalone `POST /v1/images/generations` using existing ChatGPT authorization and the Codex Images service. The five built-ins listed above retain their original IDs; `gpt-image-2` remains the default.
- Admin now displays and counts image endpoint models separately in both modes. These CPA-aligned presets are separate from account text discovery and aliases, and do not automatically verify image permissions. The Codex model-discovery compatibility baseline is `0.160.0`.
- Improved Responses image previews and authoritative completion checks, SDK event ordering, refusal handling and cancellation cleanup. Image budgets are independent: 16 MiB per item, 64 MiB per bundle and 10 images; text and hidden replay limits are unchanged.
- Preserved large integers, precise decimals and original tool JSON, including Claude non-streaming numeric output. Fixed image tool results and long-history conversion; explicit Responses history allows 4096 items / 8 MiB. Context-window metadata remains upstream-derived, with missing or conflicting values represented honestly.

**Validation and limits:** On 2026-10-04, all five built-ins each generated one image on one account with `quality:low`, `n:1`, `size:1024x1024`, `background:opaque` and `stream:true`. Every request returned HTTP 200, final `image_generation.completed` SSE and a decodable PNG in approximately 13.4–15.5 seconds. All PNGs actually measured **1254×1254** and were delivered unchanged. Exact requested dimensions, every account, higher qualities and multi-image batches are not verified by this run.

Standalone Images SSE delivers only the final image, with no progressive previews; streaming requires `n=1`, and `partial_images` must be 0 or omitted. Edits, variations and implicit generated-image history remain unsupported. Synthetic coverage of Responses image events does not establish real image-tool access on the current host. Chat/Claude explicitly reject generated image output.

At the time of the v0.2.0 release, local validation passed **2330 tests, plus build and typecheck**; there was no GitHub Actions result for that tag. Later validation on `main` is recorded under 0.3.0 above and does not retroactively validate this release tag.

See [usage / 使用说明](docs/USAGE.en.md), [中文使用说明](docs/USAGE.zh-CN.md), and the [protocol compatibility matrix](docs/protocol-compatibility.md) for the full contract.
