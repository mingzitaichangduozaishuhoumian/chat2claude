# Changelog / 更新记录

## 0.2.0 — 2026-10-04

### 中文

- 新增独立 `POST /v1/images/generations`，沿用已授权 ChatGPT 账号和 Codex Images 服务。内置 `gpt-image-1.5`、`gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-2.5`，默认仍为 `gpt-image-2`；全部 ID 原值透传。
- Admin 在简洁、专业两种模式下独立展示和计数图片接口模型；内置目录与 CPA 一致，不混入账号文本 discovery 或 alias，也不自动证明账号图片权限。模型发现的 Codex 客户端兼容基线更新为 `0.160.0`。
- 改进 Responses 流的图片预览与终态核对、SDK 事件顺序、拒绝内容和取消释放。图片使用独立预算：每项 16 MiB、每组 64 MiB、最多 10 张；文本和隐藏 replay 限额保持。
- 保留工具参数的大整数、高精度小数和原始 JSON；Claude 非流式输出也保持数值保真。修复工具结果图片与长历史转换，显式 Responses 输入历史支持 4096 项 / 8 MiB。上下文窗口使用上游元数据，缺失或账号间冲突不再伪造统一值。

**验证与边界：** 2026-10-04，在一个账号上对五个内置图片型号各请求一张，参数为 `quality:low`、`n:1`、`size:1024x1024`、`background:opaque`、`stream:true`。全部 HTTP 200、最终 `image_generation.completed` SSE 和 PNG 解码通过，每张约 13.4–15.5 秒。实际图片均为 **1254×1254**，原样交付，不能承诺精确请求尺寸、所有账号、更高质量档位或多图批次均已实测。

独立 Images SSE 只有最终图片，没有渐进预览；流式仅允许 `n=1`，`partial_images` 只能为 0 或省略。图片编辑、variations 和生成图隐式历史续聊仍不支持。Responses 的图片事件转换有合成测试覆盖，当前宿主的 Responses 图片工具不因此视为已真实验证。Chat/Claude 收到图片输出时明确报错。

发布前本地验证记录为 **2330 项测试通过，并通过 build / typecheck**。这不是 GitHub CI 结果：CI 工作流仍待具备 workflow 权限后发布，本版尚无 GitHub Actions 执行结果。

### English

- Added standalone `POST /v1/images/generations` using existing ChatGPT authorization and the Codex Images service. The five built-ins listed above retain their original IDs; `gpt-image-2` remains the default.
- Admin now displays and counts image endpoint models separately in both modes. These CPA-aligned presets are separate from account text discovery and aliases, and do not automatically verify image permissions. The Codex model-discovery compatibility baseline is `0.160.0`.
- Improved Responses image previews and authoritative completion checks, SDK event ordering, refusal handling and cancellation cleanup. Image budgets are independent: 16 MiB per item, 64 MiB per bundle and 10 images; text and hidden replay limits are unchanged.
- Preserved large integers, precise decimals and original tool JSON, including Claude non-streaming numeric output. Fixed image tool results and long-history conversion; explicit Responses history allows 4096 items / 8 MiB. Context-window metadata remains upstream-derived, with missing or conflicting values represented honestly.

**Validation and limits:** On 2026-10-04, all five built-ins each generated one image on one account with `quality:low`, `n:1`, `size:1024x1024`, `background:opaque` and `stream:true`. Every request returned HTTP 200, final `image_generation.completed` SSE and a decodable PNG in approximately 13.4–15.5 seconds. All PNGs actually measured **1254×1254** and were delivered unchanged. Exact requested dimensions, every account, higher qualities and multi-image batches are not verified by this run.

Standalone Images SSE delivers only the final image, with no progressive previews; streaming requires `n=1`, and `partial_images` must be 0 or omitted. Edits, variations and implicit generated-image history remain unsupported. Synthetic coverage of Responses image events does not establish real image-tool access on the current host. Chat/Claude explicitly reject generated image output.

Pre-release local validation: **2330 tests passed, plus build and typecheck**. No GitHub CI success is claimed: publishing the workflow still requires workflow permission, and this release has no GitHub Actions run result.

See [usage / 使用说明](docs/USAGE.en.md), [中文使用说明](docs/USAGE.zh-CN.md), and the [protocol compatibility matrix](docs/protocol-compatibility.md) for the full contract.
