# Contributing / 参与贡献

Focused fixes, documentation improvements and reproducible bug reports are welcome. Issues and pull requests may be written in Chinese or English.

欢迎小范围修复、文档改进和可复现的问题报告，中文或英文均可。使用问题请到 [Discussions](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/discussions)，安全问题请按 [SECURITY.md](SECURITY.md) 私密报告。

## Set up and verify

Use Node.js **22.15.0 or later in the 22.x line**, or **24.x**. The repository pins **pnpm 9.15.4** through `packageManager`; invoke it through Corepack. Run commands from the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm dev
```

`check` builds the workspace, runs Vitest, then typechecks. Building first matters for tests that launch a separate TypeScript process and resolve workspace packages through `dist`. `dev` builds once and starts the API watcher. See the [README](README.en.md) or [中文说明](README.md) for account and client setup.

开发环境使用上述 Node 版本与 Corepack 管理的 pnpm。`check` 顺序为构建、测试、类型检查；全新 checkout 不要跳过首次构建。修改依赖时才更新 lockfile，并说明原因。

## Make a focused change

- Follow nearby TypeScript conventions: strict types, NodeNext modules and `.js` extensions for relative imports. Keep changes in the relevant workspace package; avoid unrelated formatting or dependency updates.
- Add a regression test for a reproducible behavior change. Tests live beside the code as `*.test.ts`; use synthetic accounts, mock fetch and small fixtures. Do not make automated tests depend on personal credentials, live generation or quota resets.
- For protocol changes, preserve call IDs, field values, event ordering and cancellation behavior. Update the compatibility manifest and documentation when the supported contract changes.
- Use a topic branch and a descriptive PR. Explain the problem, resulting behavior and checks actually run. Mention any checks not run and why; local checks are not a GitHub CI result.

修改应集中在相关包中，遵循附近代码风格。协议行为变化需有真实回归用例，涉及接口能力时同步兼容清单与文档。自动测试使用合成数据，不连接个人账号或消耗真实生成额度。PR 写清问题、变化和实际验证结果，不把本地通过表述为 Actions 已通过。

For a focused test after the initial build:

```sh
corepack pnpm exec vitest run packages/protocol-mapper/src/response.test.ts
```

Before requesting review, run `corepack pnpm check` for code changes and check the relevant examples/links for documentation changes. Contributions should be yours to share under the existing [MIT license](LICENSE).

## Keep reports and patches safe

Never commit or attach `.env`, OAuth tokens, cookies, API keys, authorization headers, runtime-state files, proxy credentials, complete prompts, tool results or raw upstream logs. Use a minimal synthetic reproduction and redact screenshots. If a report may expose a vulnerability or private data, use [private reporting](SECURITY.md), not a public Issue or PR.

不要提交真实凭据、运行时状态文件、完整 prompt、工具结果或上游原始日志。使用最小合成复现；截图也需脱敏。合作交流遵循 [Code of Conduct](CODE_OF_CONDUCT.md)。
