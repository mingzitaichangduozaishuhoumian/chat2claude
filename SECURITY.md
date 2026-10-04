# Security / 安全报告

## Report privately / 私密报告

Use [GitHub private vulnerability reporting](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/security/advisories/new) for suspected vulnerabilities, authentication bypasses, credential exposure or unsafe data disclosure. Do not post exploit details or private data in public Issues, Discussions or pull requests.

发现疑似漏洞、认证绕过、凭据泄露或敏感数据暴露时，请通过上面的 **Report a vulnerability** 私密入口提交，不要公开发布利用细节或私人数据。

A useful report includes:

- Affected release or commit, platform and installation method.
- A minimal reproduction using synthetic data, expected behavior and actual impact.
- The relevant endpoint or component, without real credentials or unrelated account data.

报告请包含版本/commit、平台、安装方式、最小合成复现、预期行为与实际影响。即使使用私密报告，也不要附上真实 OAuth token、cookie、Runtime API Key、Admin key、`.env`、runtime state 或完整 prompt/上游日志。若凭据已泄露，请先撤销或轮换，而不是把它复制进报告。

## Scope and handling / 范围与处理

Please check the [latest release](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/releases/latest) when practical and state which version you tested. Fixes target the current codebase; backports and response deadlines are not guaranteed. Keep details private while a report is being assessed and a fix is coordinated.

请尽量在最新版本复现并注明测试版本。修复以当前代码为目标，不承诺历史版本回补或固定响应时限；评估与协调修复期间请保持细节私密。

Ordinary usage questions belong in [Discussions](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/discussions); non-sensitive defects belong in [Issues](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/issues/new/choose). See [SUPPORT.md](SUPPORT.md) for what to include.
