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

`--api-url` 使用主服务实际的本机根地址，不加 `/v1`。该命令通过本机管理会话保存网关地址和随机 Key，开启网页并选择**手动网页模式**，模型为 `auto`，映射为 `sonnet=auto`，声明图片输入、关闭工具调用。它会更新已有网页路由配置。若要自动选择或关闭网页，到 `/admin` → **模型映射** → **上游选择**修改。配置图片支持不代表真实识图已经验证。

所有命令支持 `--directory PATH`，例如 `corepack pnpm web-gateway:setup -- --directory D:/private/chat-web`；后续命令须传入相同目录。默认私密目录为 `apps/api/data/web-gateway/`，已由仓库 `.gitignore` 忽略。其中 `settings.json` 保存随机 API Key，`source/auth/session.json` 保存登录会话；不要提交或分享。自定义目录需自行排除版本控制。

重复 `setup` 会验证现有固定源码、补丁和安装状态，保留 Key 与会话；不会重置或删除未知目录。固定版本或补丁变化、源码出现意外修改时，请保留旧目录，使用新的 `--directory` 安装，再重新登录并接入。`status` 只检查文件和安装状态，不证明网页登录仍有效或网关端口正在运行。

## 本次补丁的边界

未打补丁的固定上游聊天接口会忽略图片。本补丁为独立网关 `POST /v1/chat/completions` 增加最小图片链路：

- 只接受 `messages` 最后一条 `role: "user"` 的**一张** `image_url`，URL 必须是规范 Base64 的 PNG、JPEG、WebP 或 GIF data URL，并与图片 MIME 签名匹配。保留文字顺序，只有图片时使用固定识图提示。
- 整个 JSON 请求最多 16 MiB，解码图片最多 10 MiB。远程 URL、多图、历史图片、非 user 图片、未知非文本块、畸形编码及 MIME 不符返回 HTTP 400，不静默转成纯文字。
- 上传确认后保留附件发送；JSON 和 SSE 都沿用文字回答。网关原生响应的 `applied.image_inputs_attached: 1` 仅表示附件链路已确认，不是回答准确性证明。
- 客户端断开会在排队执行前或发送前取消。图片发送后出错不自动重发，并在网关原生响应中以 `should_retry: false` 提示调用方，避免不确定重复调用。`applied` 和 `should_retry` 是独立网关的扩展字段，主服务的兼容 API 目前不透传这些扩展，不能在主服务响应中依赖它们。
- 独立网关原生 `/v1/responses` 暂不接受图片。主服务提供的兼容路由通过 Chat Completions 对接网关，其输入仍受上述图片限制。

这个网关**不支持工具调用**，`model` 参数仍由上游忽略，使用 `auto`；也没有 `/v1/models`，本项目依赖该端点的网页健康检查不能证明它的聊天接口可用。网页可以独立回答、分析和生成代码；需要本地文件、命令等工具的请求在手动网页模式下不可用。主服务自动模式可按现有路由规则另选兼容 Codex。

自动模式目前只依据通用 `supportsImages` 声明匹配，不能在选择上游前识别本补丁的单图限制。因此多图、带图片历史或 HTTPS 图片 URL 可能先选中网页，再由网关返回 400；请求发送给网关后不会转发 Codex 重试。使用本补丁时，应由客户端按上述单图范围组织请求。

## 验证记录与复现

2026-10-19 已在本机从全新克隆执行实际 `setup`，固定提交检出、补丁应用和依赖安装成功。主仓库 `corepack pnpm check` 通过构建、类型检查和 109 个测试文件的 2643 项测试，构建缓存测试 8/8；最终本机网关 runner 测试 19/19。安装后的 `npm run test:vision` 通过 11 组解析/HTTP 测试及 44 项文本模式/附件/关闭流程测试，覆盖 JSON/SSE、上传状态、取消、普通 Chat 模式检查和避免重复发送。

从主仓库根目录复现本项目验证：

```bash
corepack pnpm check
node --test scripts/web-gateway.test.mjs
corepack pnpm web-gateway:setup
npm --prefix apps/api/data/web-gateway/source run test:vision
```

自定义安装目录时，将最后一条命令的 `--prefix` 改为对应目录下的 `source`。这些测试使用本地 fixture 和浏览器替身，不调用真实模型；安装成功也不等于已登录。

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

真实普通 Chat 登录由本人操作，当前仍未完成真实图片上传与识图验证；不能宣称真实账号识图、回答准确性或额度表现已验证。本项目只减少直接发往 Codex 的请求，不保证增加总额度。

## English

This integration installs a separate gateway for ordinary signed-in **Chat at chatgpt.com**, independent of ChatGPT Work and this project's Codex OAuth session. It pins upstream commit `893f553be358210a5c045aa9f62b56ba1edc5c78` and applies the local vision patch. Run the setup/login/status/start commands above, keep the gateway terminal open, start the main app, then run `web-gateway:connect -- --api-url http://127.0.0.1:3000` using the main app's actual loopback origin. Login opens a separate Chrome window for you to sign in manually. Chrome, Git, Node.js and npm must already be installed.

Connect enables manual Web mode, configures `auto` with `sonnet=auto`, declares image support, and disables tools. It overwrites saved Web routing settings; use Admin to choose Auto or disable Web. The default private directory is `apps/api/data/web-gateway/`, ignored by Git; it contains the API Key and browser session. All commands accept the same `--directory PATH` override. Preserve an existing installation if its version or patch changes, and install into a new directory. Status checks installation files, not live authentication.

The patched gateway Chat Completions route accepts one canonical Base64 PNG/JPEG/WebP/GIF image on the last user message, with a 10 MiB decoded-image and 16 MiB whole-request limit. Remote URLs, multiple images, image history, non-user images and unknown content parts are rejected. The gateway's native Responses route rejects images. Attachment confirmation works with JSON/SSE, cancellation is propagated, and failures after sending are marked unsafe to retry. Tools and `/v1/models` remain unavailable, and `model` is ignored. Offline tests do not establish live recognition: **real-account upload and vision still require manual-login validation**. No additional quota is promised.

The local runner forces `ORDINARY_CHAT_ONLY=true` for strict ordinary-Chat checks on every chat request, including text and images. It checks during preparation, after thinking-mode selection, and immediately before submission, including the Enter-key fallback. Work or an unrecognized page is rejected before sending. Upstream text paths retain their default best-effort mode selection when run without this option outside the local runner. `applied.image_inputs_attached` and `should_retry` are native gateway extensions; the main compatibility API does not currently forward them. Auto routing sees the general `supportsImages` declaration, not this gateway's single-image restrictions. Multiple images, image history or HTTPS images may therefore select Web and then receive 400, with no retry through Codex after dispatch.

On 2026-10-19, a fresh local clone completed real setup, pinned checkout, patch application and dependency installation. Main-repository checks passed build/typecheck and 2643 tests in 109 files, plus 8 build-cache tests; final runner tests passed 19/19. Installed `npm run test:vision` passed 11 parser/HTTP groups and 44 text-mode/attachment/shutdown tests. Reproduction commands are listed above. Upstream `npm test` is not fully green on Windows: the SIGINT/SIGTERM mutation-rollback cases in `test-stall-gate.js` fail, yielding 14/16. The same 14/16 baseline was reproduced at the unpatched pinned SHA; other upstream suites that were run passed. This remains a Windows validation limitation. Manual account login is in progress; real upload and recognition are still unverified.
