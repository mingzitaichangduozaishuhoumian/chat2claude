# Support / 获取帮助

Start with [installation and upgrades / 安装与升级](INSTALL.md), the [中文 README](README.md), [English README](README.en.md) and [usage guides](docs/USAGE.en.md). Use the following channels:

| Topic / 类型 | Where / 渠道 |
| --- | --- |
| Setup, configuration, client usage / 安装、配置、客户端使用 | [Discussions](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/discussions) |
| Reproducible non-sensitive bug / 可复现的非敏感缺陷 | [Bug report](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/issues/new?template=bug_report.yml) |
| Proposed behavior or feature / 功能建议 | [Feature request](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/issues/new?template=feature_request.yml) |
| Vulnerability or private-data exposure / 漏洞或隐私泄露 | [Private vulnerability report](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/security/advisories/new) |

For public troubleshooting, include the release version or commit, OS, installation method, and short reproduction steps. For API problems, the endpoint, model ID, HTTP status and a sanitized error category are usually enough to begin. State what you expected and what happened. Use a small invented prompt when a request example is needed.

公开求助时，提供版本或 commit、系统、安装方式、简短复现步骤、预期和实际结果即可。接口问题可补充 endpoint、模型 ID、HTTP 状态和脱敏错误类别；需要请求示例时请使用简短的合成 prompt。

Do not upload OAuth tokens, cookies, API keys, authorization headers, `.env`, runtime-state files, credential-bearing proxy URLs, complete prompts, tool outputs or full/raw upstream logs. Check screenshots and copied commands for secrets before posting. A complete state export is not needed for support.

不要上传 OAuth token、cookie、API key、Authorization header、`.env`、runtime state、带凭据的代理地址、完整 prompt、工具输出或完整/原始上游日志。提交前检查截图和复制的命令；排障不需要完整状态导出。

Responses depend on maintainer availability; no fixed response time is promised. Search existing topics first and keep follow-up details in the same discussion or issue.
