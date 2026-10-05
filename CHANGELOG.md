# Changelog / 更新记录

## Unreleased

以下应用改进已合入 `main`，尚未包含在 v0.2.1 安装包中。仓库自动化已启用。

The following application changes are on `main` and are not included in the v0.2.1 archives. Repository automation is already enabled.

### 中文

- 账号模型按文本、图片分类计数并默认折叠，展开后使用紧凑型号标签；图片接口地址只显示一次。专业模式的账号诊断、上下文详情及模型页使用说明按需展开。
- 明确区分文本 alias 与图片生成接口；保存时拒绝已知图片型号作为新文本 alias 或后端目标，历史误绑仍可禁用、解绑、修正或删除。
- 源码启动改为按需编译：复用未变化的成功构建，源码、配置、依赖或产物变化时重建。保留强制构建命令，并提供 `build --if-needed` 预检。
- 启用 GitHub Actions CI 和标签自动发包；手动发包流程只生成验证工件，不发布或覆盖现有版本。
- 更新中英 README 的源码升级、分类界面、启动方式和源码版/安装包数据目录说明。

### English

- Grouped account models into collapsed text/image catalogs with compact model-ID labels and a single Images endpoint per group. Account diagnostics, context details, and model-page guidance expand on demand.
- Distinguished text aliases from image generation. Admin now rejects registered image IDs as new text aliases or backend targets while keeping legacy bindings repairable and removable.
- Added source build caching: reuse unchanged successful builds and rebuild when source, configuration, dependencies, or outputs change. Forced builds remain available; `build --if-needed` prepares the build without starting the service.
- Enabled GitHub Actions CI and tag-based releases. Manual packaging runs produce verification artifacts without publishing or overwriting releases.
- Updated both READMEs with source updates, grouped model controls, startup behavior, and source/package data-directory differences.

**验证 / Verification（2026-10-05，`cf88c77`）：** [Windows/Linux × Node 22/24 CI](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/actions/runs/37273614978) 全部通过 / passed；[自动打包试运行 / packaging dry run](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/actions/runs/37273646542) 完成 Linux 构建与同批 Windows 运行时验证 / passed Linux build and Windows runtime checks. 未执行发布步骤 / publication was skipped.

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

v0.2.0 发布时，本地验证记录为 **2330 项测试通过，并通过 build / typecheck**；当时尚无该标签的 GitHub Actions 执行结果。后续 `main` 分支的云端验证记录见上方 Unreleased，不追溯视为本标签的 CI 验证。

### English

- Added standalone `POST /v1/images/generations` using existing ChatGPT authorization and the Codex Images service. The five built-ins listed above retain their original IDs; `gpt-image-2` remains the default.
- Admin now displays and counts image endpoint models separately in both modes. These CPA-aligned presets are separate from account text discovery and aliases, and do not automatically verify image permissions. The Codex model-discovery compatibility baseline is `0.160.0`.
- Improved Responses image previews and authoritative completion checks, SDK event ordering, refusal handling and cancellation cleanup. Image budgets are independent: 16 MiB per item, 64 MiB per bundle and 10 images; text and hidden replay limits are unchanged.
- Preserved large integers, precise decimals and original tool JSON, including Claude non-streaming numeric output. Fixed image tool results and long-history conversion; explicit Responses history allows 4096 items / 8 MiB. Context-window metadata remains upstream-derived, with missing or conflicting values represented honestly.

**Validation and limits:** On 2026-10-04, all five built-ins each generated one image on one account with `quality:low`, `n:1`, `size:1024x1024`, `background:opaque` and `stream:true`. Every request returned HTTP 200, final `image_generation.completed` SSE and a decodable PNG in approximately 13.4–15.5 seconds. All PNGs actually measured **1254×1254** and were delivered unchanged. Exact requested dimensions, every account, higher qualities and multi-image batches are not verified by this run.

Standalone Images SSE delivers only the final image, with no progressive previews; streaming requires `n=1`, and `partial_images` must be 0 or omitted. Edits, variations and implicit generated-image history remain unsupported. Synthetic coverage of Responses image events does not establish real image-tool access on the current host. Chat/Claude explicitly reject generated image output.

At the time of the v0.2.0 release, local validation passed **2330 tests, plus build and typecheck**; there was no GitHub Actions result for that tag. Later validation on `main` is recorded under Unreleased above and does not retroactively validate this release tag.

See [usage / 使用说明](docs/USAGE.en.md), [中文使用说明](docs/USAGE.zh-CN.md), and the [protocol compatibility matrix](docs/protocol-compatibility.md) for the full contract.
