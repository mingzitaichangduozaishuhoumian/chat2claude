# 普通 Chat 网页网关 / Ordinary Chat web gateway

此集成安装独立的 [stufently/gpt-web-gateway](https://github.com/stufently/gpt-web-gateway)，通过本人手动登录的 **chatgpt.com 普通 Chat 对话页**处理请求。它不是 ChatGPT Work，也不使用本项目的 Codex OAuth 会话。主服务负责兼容 API 与上游选择，独立网关负责浏览器和网页会话。

本机启动器强制设置 `ORDINARY_CHAT_ONLY=true`，对所有聊天请求（纯文本和图片）严格检查普通 Chat 模式，在准备、切换思考模式后和真正发送前再次确认；检测到 Work 或无法辨识当前页面时拒绝发送，包括按 Enter 的发送备用路径。未通过本机启动器且未开启该选项的上游纯文本路径，仍保留默认的尽力切换模式行为。

固定上游提交为 [`893f553be358210a5c045aa9f62b56ba1edc5c78`](https://github.com/stufently/gpt-web-gateway/tree/893f553be358210a5c045aa9f62b56ba1edc5c78)，来源记录在 [upstream.json](upstream.json)。`setup` 检出该提交并应用 [chat-vision.patch](chat-vision.patch)，不跟随上游分支自动更新。上游 MIT 许可保留在 [LICENSE.upstream](LICENSE.upstream)。

## 安装、登录与接入

需要本项目支持的 Node.js、npm、Git，以及已安装的 Google Chrome。从本项目根目录执行：

```bash
corepack pnpm web-gateway:setup
corepack pnpm web-gateway:login
```

`setup` 下载固定源码、应用补丁并安装依赖，不自动下载浏览器。`login` 打开独立 Chrome 窗口；请本人完成普通 Chat 登录。确认登录后，脚本保存会话并关闭这个窗口，不读取现有 Chrome profile，也不代填密码、验证码或双重验证。

查看安装与会话文件状态，然后在单独的终端前台运行网关：

```bash
corepack pnpm web-gateway:status
corepack pnpm web-gateway:start
```

默认网关地址是 `http://127.0.0.1:3101`，OpenAI 客户端前缀为 `http://127.0.0.1:3101/v1`。保持该终端运行，Ctrl+C 停止。主项目仍用 `start.bat`、`sh ./start.sh` 或 `corepack pnpm start` 启动。在主服务已运行的另一个终端执行：

```bash
corepack pnpm web-gateway:connect -- --api-url http://127.0.0.1:3000
```

`--api-url` 使用主服务实际的本机根地址，不加 `/v1`。该命令通过本机管理会话保存网关地址和随机 Key，开启网页并选择**手动网页模式**，模型为 `auto`，映射为 `sonnet=auto`，开启图片输入、工具调用和 `contextHandoff` 可见上下文接续。它会更新已有网页路由配置。若要自动选择或关闭网页，到 `/admin` → **模型映射** → **上游选择**修改。能力声明不等于真实验证；下方分别记录 2026-10-20 双图及工具联调，以及 2026-10-19 单图历史结果，均有明确验证范围。

所有命令支持 `--directory PATH`，例如 `corepack pnpm web-gateway:setup -- --directory D:/private/chat-web`；后续命令须传入相同目录。默认私密目录为 `apps/api/data/web-gateway/`，已由仓库 `.gitignore` 忽略。其中 `settings.json` 保存随机 API Key，`source/auth/session.json` 保存登录会话；不要提交或分享。自定义目录需自行排除版本控制。

重复 `setup` 会验证现有固定源码、补丁和安装状态，保留 Key 与会话；不会重置或删除未知目录。固定版本或补丁变化、源码出现意外修改时，请保留旧目录，使用新的 `--directory` 安装，再重新登录并接入。`status` 只检查文件和安装状态，不证明网页登录仍有效或网关端口正在运行。

## 本次补丁的边界

未打补丁的固定上游聊天接口会忽略图片，且没有原生工具调用。本补丁为独立网关 `POST /v1/chat/completions` 增加图片历史及工具文本协议：

- 接受当前及历史 `role: "user"` 消息中的 `image_url`，URL 必须是规范 Base64 的 PNG、JPEG、WebP 或 GIF data URL，并与图片 MIME 签名匹配。保留文字顺序及每张图片所属消息，不把图片静默丢弃或归到其他消息。
- 整个 JSON 请求最多 16 MiB；所有 user 消息及历史累计最多 10 张图片、解码图片累计最多 10 MiB。远程 URL（包括 HTTPS）、非 user 图片、未知非文本块、畸形编码及 MIME 不符返回 HTTP 400。
- 逐项确认附件后保留附件发送；JSON 和 SSE 返回文本或标准工具调用。网关原生响应的 `applied.image_inputs_attached` 仅报告已确认附件数，不是回答准确性证明。
- 客户端断开会在排队执行前或发送前取消。图片发送后出错不自动重发，并在网关原生响应中以 `should_retry: false` 提示调用方，避免不确定重复调用。`applied` 和 `should_retry` 是独立网关的扩展字段，主服务的兼容 API 目前不透传这些扩展，不能在主服务响应中依赖它们。
- 独立网关原生 `/v1/responses` 仍拒绝图片和工具。主服务提供的 Responses 兼容路由通过 Chat Completions 对接网关，可使用这里支持的图片及工具子集。

工具采用受校验的文本协议，让网页模型输出标准 JSON/SSE `tool_calls`；实际文件读写、命令和其他工具始终由客户端执行，网关不运行模型生成的工具。可声明最多 128 个唯一 function，名称为 1–64 个 ASCII 字母、数字、下划线或连字符。每次新输出最多 8 个调用，`parallel_tool_calls=false` 时最多 1 个；一条 assistant 历史中的 `tool_calls` 最多 128 个，必须各自有唯一且完整的后续 tool 结果，才能继续下一条非 tool 消息。单项参数最多 1 MiB，原始参数字符串及数值字面量保留。`strict:true` 被明确拒绝，不承诺原生严格 JSON Schema 执行；不合约的工具输出不会转成成功的工具调用。

工具回复须完整通过协议校验后，才返回客户端或分块输出 SSE 参数；不会把未经确认的部分 JSON 转成工具调用。完整 JSON 可使用受支持的单层包装，包装外不能带其他说明，不能嵌套包装；解包后仍严格校验 JSON、请求 nonce、声明的工具名、调用数量及参数。

网页兼容补丁支持中文“聊天 / 工作”按钮的 `aria-pressed` 活跃状态，并按中文附件移除标签精确核对文件名。每次请求生成独立的 ASCII UUID 文件名，避免网页将同名上传改成带 `(1)` 的名称；不会放宽校验接受其他附件。严格模式的新会话最多等待 60 秒让输入框出现，超时或页面状态无法确认时拒绝发送。

图片请求先填入完整文字，再批量上传并确认附件；上传后只读核对文字及附件，不重新填入输入框，避免覆盖已上传图片。确认普通 Chat 模式、完整文字和全部预期附件后才发送。

未指定 `conversationId` 且未开启 `reuseChat` 的独立图片请求，会新建当前槽位的页面并完整初始化，修复旧页面导航后附件状态不稳定的问题；其他槽位和显式复用会话保持各自的生命周期。

`model` 参数仍由上游忽略，使用 `auto`；也没有 `/v1/models`，本项目依赖该端点的网页健康检查不能证明它的聊天接口可用。工具协议受网页输出及上述校验范围限制；它不是官方原生工具执行环境，也不会为网页挂载本地工程。

自动模式按通用 `supportsImages` 和 `supportsTools` 声明匹配，不能预判本补丁的全部大小、格式及文本协议约束。HTTPS 图片或图片总量超限可能先选中网页，再由网关返回 400；请求发送给网关后不会转发 Codex 重试。`connect` 还会配置 `supportsStrictTools:false`，让主服务在发送前排除要求 `strict:true` 的网页请求；手动网页模式明确拒绝，自动模式可另选兼容 Codex。

## 同一客户端工程的可见上下文接续

主服务的 `contextHandoff` 默认关闭，可在管理台开启，或预置 `CHATGPT_CONTEXT_HANDOFF=true`；`web-gateway:connect` 会主动开启。开启后，Responses 可通过 `previous_response_id` 跨 Codex/网页或在明确换模型时接续同一 API 用户已保存的可见历史；Messages/Chat 可转交已完成工具循环的公开调用 ID、原始参数和结果。私有 reasoning、原生消息 ID 不跨后端传递，未知原生块及未完成工具不能转交；同 provider、同模型仍绑定原账号。

同一个客户端继续持有本地工程、工具执行权限和完整可见对话。文件内容、修改状态和测试证据需要客户端回传，主服务不会同步 ChatGPT Projects、挂载目录或自动读取工程。Responses 历史默认仅在内存保留 30 分钟，隐式 reasoning replay 默认 10 分钟，均按 API 用户隔离、有容量限制且重启失效；客户端必须保留并在需要时重发完整历史。不能仅因两个后端指向同一目录就假设它们知道最新状态。

## 验证记录与复现

2026-10-20 当前自动化验证：默认 `corepack pnpm check` 的构建通过，但默认高并发 Vitest 出现 3 项既有测试的 5 秒超时，无断言失败，因此不记为整条 `pnpm check` 通过。这 3 项涉及的文件以单 worker 复跑，91/91 通过；完整 Vitest 使用 `--maxWorkers=2` 后，113 个文件、2707/2707 项通过。所有包的类型检查、build-cache 8/8 和网关 runner 19/19 也通过。

旧提交的 Ubuntu Node 24 CI 在依赖审计中被 `source-map-js@1.2.1` 的高危公告阻挡；已仅将该传递依赖锁定至 `1.2.2`。修复后 `pnpm audit --audit-level high` 报告无已知漏洞，锁定安装、全工作区构建和类型检查通过；新提交的 CI 结果仍需单独确认。

最终 `test:vision` 通过 11 组 vision 解析/HTTP 测试、18/18 项工具协议测试，以及 73 项附件/文本模式和关闭流程测试（附件/文本模式 71 项、关闭流程 2 项）。这些自动化验证使用本地 fixture 或浏览器替身；真实网页结果单独记录如下。

2026-10-20，最终已安装补丁在同一次内存应用运行中连续通过两轮真实网页请求（合成 Codex 源 1 次、真实 Web 2 次）；两轮图片请求均新建本槽页面，使用同一个本人普通 Chat 账号和两张合成 PNG。第一段以 `createApp` 内存实例的一次合成 Codex 回复建立 Responses 历史，再通过 `previous_response_id` 接续真实网页；第二段将网页实际返回的调用 ID 配对模拟客户端工具结果，继续完整双图历史：

| 路径 | 实测结果 |
| --- | --- |
| Responses 可见历史接续到真实网页 | HTTP 200；标准 `function_call` 参数正确包含此前项目代号、旧图数字 73 和当前图数字 29。发送前核对私有 reasoning 和原生消息 ID 未传入网页。 |
| 真实调用 ID + 模拟客户端结果，经 Messages SSE 接续真实网页 | HTTP 200，`x-chat2claude-backend: web`，完整 `message_stop`；回复中的项目代号、两图数字和模拟结果回执正确。完整历史仍包含两张 PNG。 |

源 Codex 步骤只调用一次测试替身，未调用真实 Codex 账号；客户端工具结果是合成回执，没有实际执行文件读写或命令。这两段生成请求只发往当前构建的内存应用实例。运行中的 3000 主服务已保存并核对手动网页、`contextHandoff=true`、工具和图片开启、`supportsStrictTools=false`，但没有对其发送本次生成测试。结果证明上述单账号双 PNG 两段链路，不证明其他账号、格式、长期可靠性或额度关系。原始提示词、回答、会话、日志和截图不纳入仓库。

以下是 **2026-10-19 单图版本的历史记录**，保留当时的源码、配置和验证事实。

2026-10-19 已在本机从全新克隆执行实际 `setup`，固定提交检出、补丁应用和依赖安装成功。主仓库最终一轮 `corepack pnpm check` 通过构建、类型检查和 109 个测试文件的 2643 项测试，构建缓存测试 8/8、runner 测试 19/19。最终已安装源码的 `npm run test:vision` 通过 11 组解析/HTTP 测试及 53 项测试（51 项文本模式/附件相关、2 项关闭流程）；composer 11/11、Express 兼容 11/11、本机网关 runner 19/19 也通过。

本人手动登录普通 Chat 后，已完成两条真实识图路径：

| 路径 | 实测结果 |
| --- | --- |
| 直连固定补丁网关 Chat Completions JSON | HTTP 200；正确识别合成测试 PNG 的数字 73、左侧蓝色方块和右侧橙色圆。 |
| 当前构建 `createApp` 内存实例的 `/v1/messages` SSE | HTTP 200，`x-chat2claude-backend: web`，收到完整 `message_stop`；该实例 `codexCalls=0`，同样正确识别数字、颜色、形状和左右位置。 |

第二条验证确实调用真实网页网关，但调用入口是当时构建的内存应用实例，未向运行中的 3000 服务发送生成请求。3000 服务当时仅已通过本机管理 API 保存接入配置，并经 GET 核对：`webEnabled=true`、`mode=web`、模型 `auto`、`sonnet=auto`、图片输入开启、工具关闭。当时正式网关 runner 已恢复启动，会话预热就绪。这次历史验证只证明一个本人账号和一张 PNG 的成功链路，不证明 JPEG/WebP/GIF、其他账号、长期稳定性、全部型号或额度关系。原始提示词、回答、会话、日志和截图不纳入仓库。

从主仓库根目录复现本项目验证：

```bash
corepack pnpm check
corepack pnpm exec vitest run --maxWorkers=2
corepack pnpm typecheck
node --test scripts/build-cache.test.mjs
node --test scripts/web-gateway.test.mjs
corepack pnpm web-gateway:setup
npm --prefix apps/api/data/web-gateway/source run test:vision
node apps/api/data/web-gateway/source/scripts/test-composer-dom.js
node apps/api/data/web-gateway/source/scripts/test-express5-compat.js
```

自定义安装目录时，将示例中的 `apps/api/data/web-gateway` 替换为该目录，`npm --prefix` 指向其中的 `source`。这些测试使用本地 fixture 和浏览器替身，不调用真实模型；安装成功也不等于已登录。

上游完整 `npm test` **未全绿**：Windows 的 `scripts/test-stall-gate.js` 中，SIGINT/SIGTERM 中断后的 mutation 恢复两项失败，该文件结果为 14/16。在未打补丁的原始固定 SHA 已复现相同 14/16 基线；其他已执行的上游 suite 通过。因此这两项不是本次补丁引入的新失败，但仍保留为当前 Windows 验证限制。可复现完整上游测试：

```bash
npm --prefix apps/api/data/web-gateway/source test
```

复现未打补丁基线时，在新的临时目录执行：

```bash
git clone --no-checkout https://github.com/stufently/gpt-web-gateway.git gpt-web-gateway-baseline
git -C gpt-web-gateway-baseline checkout --detach 893f553be358210a5c045aa9f62b56ba1edc5c78
node --test gpt-web-gateway-baseline/scripts/test-stall-gate.js
```

后续账号与格式仍需各自实测。本项目只减少直接发往 Codex 的请求，不保证增加总额度。

## English

This integration installs a separate gateway for ordinary signed-in **Chat at chatgpt.com**, independent of ChatGPT Work and this project's Codex OAuth session. It pins upstream commit `893f553be358210a5c045aa9f62b56ba1edc5c78` and applies the local vision patch. Run the setup/login/status/start commands above, keep the gateway terminal open, start the main app, then run `web-gateway:connect -- --api-url http://127.0.0.1:3000` using the main app's actual loopback origin. Login opens a separate Chrome window for you to sign in manually. Chrome, Git, Node.js and npm must already be installed.

Connect enables manual Web mode, configures `auto` with `sonnet=auto`, and enables image input, tools and visible-context handoff. It overwrites saved Web routing settings; use Admin to choose Auto or disable Web. The default private directory is `apps/api/data/web-gateway/`, ignored by Git; it contains the API Key and browser session. All commands accept the same `--directory PATH` override. Preserve an existing installation if its version or patch changes, and install into a new directory. Status checks installation files, not live authentication.

The patched Chat Completions route accepts canonical Base64 PNG/JPEG/WebP/GIF images across current and historical user messages, preserving image ownership and text order. The whole conversation is limited to 10 images and 10 MiB of decoded image data within a 16 MiB JSON request. Remote URLs, including HTTPS, non-user images and unknown content parts are rejected. The gateway's native Responses route rejects images and tools; the main service's Responses route uses Chat Completions instead. Attachment confirmation works with JSON/SSE, cancellation is propagated, and failures after sending are marked unsafe to retry. `/v1/models` remains absent and `model` is ignored. Chinese Chat/Work `aria-pressed` and exact attachment labels are supported; every image uses a unique ASCII UUID filename. Strict new-chat setup waits up to 60 seconds for the composer and rejects uncertain pages.

The tool text protocol returns standard JSON/SSE tool calls for the client to execute. The gateway never executes tools. It accepts up to 128 unique function definitions, with names of 1–64 ASCII letters, digits, underscores or hyphens; a new response has at most 8 calls, or 1 when `parallel_tool_calls=false`. Each assistant history group may contain at most 128 calls, with one unique result per call before the next non-tool message. Arguments are capped at 1 MiB each and their original strings and numeric tokens are retained. `strict:true` is rejected; this does not promise native strict JSON Schema execution. No additional quota is promised.

The complete tool reply must pass protocol validation before a client response or chunked SSE arguments are emitted. Partial, unverified JSON cannot become a tool call. Complete JSON may use a supported single wrapper, without surrounding prose or nested wrappers; JSON, request nonce, declared function names, call limits and arguments remain strictly validated after unwrapping.

For image requests, the gateway fills the complete text before uploading and confirming the image batch. After upload it only reads back the text and attachment state, without refilling the composer and overwriting attachments. Submission requires confirmed ordinary Chat mode, complete text and every expected attachment.

An independent image request without conversationId or reuseChat gets a newly created, fully initialized page for its own slot. This fixes unstable attachment state after navigating an old page; other slots and explicitly reused conversations retain their own lifecycle.

Main-service `contextHandoff` defaults to false; enable it in Admin or through `CHATGPT_CONTEXT_HANDOFF=true`. Connect explicitly enables it. Responses can transfer the same API owner's stored visible history across providers or an explicit model change; Messages/Chat can hand over completed public tool cycles. Private reasoning and native message IDs stay local to their provider, and incomplete tools or unknown native items cannot transfer. The same provider and model retain original account affinity. Keep the same client workspace and executor: no ChatGPT Projects synchronization, directory mount or automatic file read is provided. Responses history defaults to 30 minutes in memory and implicit replay to 10 minutes; both are owner-isolated, bounded and lost on restart. Clients must retain and resend necessary complete history.

The local runner forces `ORDINARY_CHAT_ONLY=true` for strict ordinary-Chat checks on every chat request, including text and images. It checks during preparation, after thinking-mode selection, and immediately before submission, including the Enter-key fallback. Work or an unrecognized page is rejected before sending. Upstream text paths retain their default best-effort mode selection when run without this option outside the local runner. `applied.image_inputs_attached` and `should_retry` are native gateway extensions; the main compatibility API does not currently forward them. Auto routing cannot predict every gateway limit; HTTPS images or excess input can receive 400 after selecting Web, with no Codex retry after dispatch. Connect also sets supportsStrictTools:false, excluding strict:true requests before Web dispatch: manual Web rejects them and Auto may select compatible Codex.

Current automated validation on 2026-10-20: the build phase of default `corepack pnpm check` passed, but default high-concurrency Vitest hit three existing tests' 5-second timeouts, with no assertion failures. The entire `pnpm check` is therefore not recorded as passing. A single-worker rerun of the three affected files passed 91/91 tests; the full Vitest run with `--maxWorkers=2` passed 2707/2707 tests in 113 files. All packages passed typechecking, build-cache passed 8/8, and the gateway runner passed 19/19.

The prior commit's Ubuntu Node 24 CI was blocked by the high-severity advisory for `source-map-js@1.2.1`. Only that transitive dependency's lock entry was updated to `1.2.2`. After the fix, `pnpm audit --audit-level high` reported no known vulnerabilities, and frozen-lockfile installation, workspace build and typechecking passed. The new commit's CI result still requires separate confirmation.

The final test:vision run passed 11 vision parser/HTTP groups, 18/18 tool-protocol tests, and 73 attachment/text-mode/shutdown tests (71 attachment/text-mode plus 2 shutdown). These automated checks use local fixtures or browser substitutes; real Web results are recorded separately below. Reproduction commands above include the bounded-worker run.

On 2026-10-20, the final installed patch passed two consecutive real Web requests in one in-memory app run (1 synthetic Codex call, 2 real Web requests). Each image request used a fresh page in its own slot, with the same ordinary Chat account and two synthetic PNGs. An in-memory createApp instance first stored one synthetic Codex response, then continued its Responses history on real Web through previous_response_id. Standard function_call arguments correctly included the earlier project code, digits 73 in the historical PNG and 29 in the current PNG. Before dispatch, a check confirmed private reasoning and native message IDs were absent from the Web request.

The real call ID was then paired with a simulated client tool result and the complete two-PNG history was continued through Messages SSE on real Web. It returned HTTP 200, x-chat2claude-backend: web, complete message_stop and correct project code, both image digits and the simulated result receipt. The source Codex step made one mock call, without using a real Codex account. No file read/write or command tool was executed; the tool result was synthetic.

Generation checks used the current build's in-memory app, not the running port-3000 service. That service was configured and checked for manual Web, contextHandoff=true, tools and images enabled, and supportsStrictTools=false. These results establish the two stated stages for one account and two PNGs, without proving other accounts, formats, long-term reliability or quotas. Raw prompts, replies, sessions, logs and screenshots are not included in the repository.

The following 2026-10-19 results are historical checks of the single-image version, retaining the source, configuration and validation facts from that date.

On 2026-10-19, a fresh local clone completed real setup, pinned checkout, patch application and dependency installation. The final main-repository check passed build/typecheck and 2643 tests in 109 files, plus 8 build-cache tests and 19 runner tests. Final installed-source `npm run test:vision` passed 11 parser/HTTP groups and 53 text-mode/attachment/shutdown tests (51 plus 2); composer 11/11, Express compatibility 11/11 and runner 19/19 also passed. Reproduction commands are listed above. Upstream `npm test` is not fully green on Windows: the SIGINT/SIGTERM mutation-rollback cases in `test-stall-gate.js` fail, yielding 14/16. The same 14/16 baseline was reproduced at the unpatched pinned SHA; other upstream suites that were run passed. This remains a Windows validation limitation.

After the user manually signed in to ordinary Chat, direct gateway JSON returned HTTP 200 and correctly identified a test PNG's digits 73, blue square on the left, and orange circle on the right. The current build's in-memory `createApp` instance also passed a real `/v1/messages` SSE call through the gateway: HTTP 200, `x-chat2claude-backend: web`, complete `message_stop`, zero Codex calls, and the same correct recognition. This was not a generation request to the running port-3000 service. Its local Admin API saved the configuration and a GET confirmed Web enabled, manual Web mode, `auto`, `sonnet=auto`, images enabled and tools disabled. The regular gateway runner was restarted and session warm-up reported ready. The result establishes one account and one PNG; other formats/accounts, long-term reliability and quota relationships remain unverified. Raw prompts, replies, sessions, logs and screenshots are not included in the repository.
