# 使用 Claude Code

本指南说明如何把本项目作为 Claude Code 的直接 API 提供方使用。项目对外提供 Claude Messages API；启动服务、完成本地授权并取得 Runtime API Key 后，即可在 Claude Code 中使用。

## 前置条件

1. 在项目根目录启动服务：

   ```bat
   start.bat
   ```

   或在 Git Bash、Linux、macOS 中运行：

   ```bash
   ./start.sh
   ```

2. 打开 <http://127.0.0.1:3000/admin>，完成 Codex OAuth 授权。
3. 授权完成后，立即复制页面显示的 **Runtime API Key**。

默认服务端口是 `3000`。如果通过 `PORT` 改用了其他端口，请将下面所有示例中的 `3000` 替换为实际端口，例如 `PORT=3100` 时使用 `http://127.0.0.1:3100`。文档统一使用 `127.0.0.1`，以明确表示仅连接本机服务。

Runtime API Key 是 `/v1/*` 客户端凭据，Admin 浏览器会话不能替代它。原始 Key 只在创建时显示一次；如果遗失，请重新打开本机 `/admin`，点击 **Generate New Key（生成新的 Runtime API Key）**，复制新 Key 即可，**不需要再次进行 OAuth 授权**。新 Key 不会撤销现有 Key；如需作废遗失的旧 Key，再在后台的 Runtime Key 列表中撤销它。

## 配置 Claude Code

Claude Code 的 API 基地址必须填写服务的**根 origin**，不要附加 `/v1`：

```text
http://127.0.0.1:3000
```

不要配置为 `http://127.0.0.1:3000/v1`。Claude Code 会在基地址后拼接 Claude API 路径；本项目实际 Messages 端点为 `POST /v1/messages`。

### 临时配置

在启动 Claude Code 的同一个终端设置环境变量。

#### PowerShell

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3000"
$env:ANTHROPIC_AUTH_TOKEN = "sk-runtime-..."
claude
```

#### CMD

```bat
set "ANTHROPIC_BASE_URL=http://127.0.0.1:3000"
set "ANTHROPIC_AUTH_TOKEN=sk-runtime-..."
claude
```

#### Git Bash、Linux 或 macOS

```bash
export ANTHROPIC_BASE_URL='http://127.0.0.1:3000'
export ANTHROPIC_AUTH_TOKEN='sk-runtime-...'
claude
```

将 `sk-runtime-...` 替换为 `/admin` 一次性显示的 Runtime API Key。该 Key 会通过 `Authorization: Bearer <key>` 认证；项目也接受 `x-api-key`，但 Claude Code 配置应使用上述认证令牌变量。

### 安全检查环境变量

检查时不要直接 `echo` 或 `printenv` 输出完整 Key。可以只确认变量已设置，并验证健康检查；下面的命令不会打印 Key 内容：

#### PowerShell 安全检查

```powershell
if ([string]::IsNullOrWhiteSpace($env:ANTHROPIC_BASE_URL)) { throw "ANTHROPIC_BASE_URL 未设置" }
if ([string]::IsNullOrWhiteSpace($env:ANTHROPIC_AUTH_TOKEN)) { throw "ANTHROPIC_AUTH_TOKEN 未设置" }
Write-Output "ANTHROPIC_BASE_URL=$env:ANTHROPIC_BASE_URL"
Write-Output "ANTHROPIC_AUTH_TOKEN=已设置（内容已隐藏）"
Invoke-RestMethod "$env:ANTHROPIC_BASE_URL/healthz" | Out-Null
Write-Output "healthz=OK"
```

#### CMD 安全检查

```bat
if "%ANTHROPIC_BASE_URL%"=="" (echo ANTHROPIC_BASE_URL 未设置 1>&2 & exit /b 1)
if "%ANTHROPIC_AUTH_TOKEN%"=="" (echo ANTHROPIC_AUTH_TOKEN 未设置 1>&2 & exit /b 1)
echo ANTHROPIC_BASE_URL=%ANTHROPIC_BASE_URL%
echo ANTHROPIC_AUTH_TOKEN=已设置（内容已隐藏）
curl.exe "%ANTHROPIC_BASE_URL%/healthz"
```

#### Git Bash、Linux 或 macOS 安全检查

```bash
: "${ANTHROPIC_BASE_URL:?ANTHROPIC_BASE_URL 未设置}"
: "${ANTHROPIC_AUTH_TOKEN:?ANTHROPIC_AUTH_TOKEN 未设置}"
printf 'ANTHROPIC_BASE_URL=%s\n' "$ANTHROPIC_BASE_URL"
printf 'ANTHROPIC_AUTH_TOKEN=已设置（内容已隐藏）\n'
curl --fail "$ANTHROPIC_BASE_URL/healthz"
```

### Claude Code settings 示例

也可以将环境变量放入 Claude Code 的设置文件（例如 `~/.claude/settings.json`），避免每次开启新终端都重新导出。下面的模型覆盖全部使用项目内置别名，不要填入未在 `/v1/models` 中出现的后端模型 ID：

```json
{
  "model": "sonnet",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3000",
    "ANTHROPIC_AUTH_TOKEN": "sk-runtime-...",
    "ANTHROPIC_MODEL": "sonnet",
    "ANTHROPIC_REASONING_MODEL": "sonnet",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "opus",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "sonnet",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "haiku",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "fable"
  }
}
```

该配置会把 Claude Code 的主模型和 reasoning model 设为 `sonnet`，并将 Opus、Sonnet、Haiku、Fable 四类模型分别映射到项目内置的 `opus`、`sonnet`、`haiku`、`fable` alias。如果某个 alias 尚未绑定有效后端模型，请先在 `/admin` 模型管理中完成绑定。该文件包含访问凭据，请勿提交到仓库、同步到公共位置或分享给他人。修改设置后，请关闭已有 Claude Code 会话并重新加载 VS Code 或终端。

## 选择模型

项目内置四个 Claude Code 可用的别名：

| 别名 | 默认 reasoning effort | 初始可用性 |
| --- | --- | --- |
| `sonnet` | `medium` | 标准 OAuth provisioning 会自动选择已发现的后端模型并绑定此别名。推荐先使用它。 |
| `haiku` | `low` | 内置但默认未绑定；需在 `/admin` 专业模式将其绑定到 discovery 中的后端模型。 |
| `fable` | `high` | 内置但默认未绑定；需先绑定有效后端模型。它不是硬编码的生产模型 ID。 |
| `opus` | `high` | 内置但默认未绑定；需先绑定有效后端模型。 |

在 Claude Code 中选择 `sonnet` 作为首次验证。要使用其他别名，请先在 `/admin` 的模型管理中刷新 discovery，并把别名映射到可用的 backend model。`GET /v1/models` 只会返回已启用且可解析的别名及 discovery passthrough 模型。

## 服务端 Key 的替代配置

默认流程由 `/admin` 生成并持久化 Runtime API Key。若要在启动前固定服务端访问 Key，可设置以逗号分隔的 `API_KEYS`：

```bash
API_KEYS='sk-local-1,sk-local-2' ./start.sh
```

这是服务端设置，不是 Claude Code 设置。Claude Code 仍应把其中一个 Key 配置为 `ANTHROPIC_AUTH_TOKEN`。服务监听非 loopback 地址时，若未预先设置 `API_KEYS`，会拒绝启动以避免匿名初始化暴露。

## 故障排除

| 现象 | 原因与解决方法 |
| --- | --- |
| `401`，提示先访问 `/admin` 初始化 | `/v1/*` 必须使用有效的 Runtime API Key 或静态 `API_KEYS`。完成 `/admin` 授权并配置 `ANTHROPIC_AUTH_TOKEN`；浏览器 Admin 会话不能用于 API。 |
| 请求地址包含重复的 `/v1` 或返回路由错误 | `ANTHROPIC_BASE_URL` 填写了 `/v1`。改为服务 origin，例如 `http://127.0.0.1:3000`；若设置了自定义 `PORT`，使用实际端口。 |
| `message.role must be user or assistant` | **先检查 `ANTHROPIC_BASE_URL` 是否错误地包含 `/v1`，或是否指向了错误的 OpenAI 兼容端点。** Claude Code 应通过根 origin 调用本项目的 `POST /v1/messages`。确认 base URL 正确后，Claude Messages 的 `messages` 中只发送 `user` 和 `assistant`；系统提示放在顶层 `system` 字段，不要在 `messages` 中发送 `system`、`developer` 或 `tool` role。 |
| `gpt-6-astra` 错误或模型不可用 | 项目没有为 `gpt-6-astra` 提供特殊的内置别名或硬编码映射。检查 `GET /v1/models`（携带 API Key）中实际可用的模型；使用已列出的模型，或在 `/admin` 刷新 discovery 后将一个别名绑定到可用的后端模型。 |
| 别名未绑定、已禁用或后端模型已失效 | 在 `/admin` 刷新模型 discovery，确认别名启用并绑定到当前可用的 backend model。首次使用优先选 `sonnet`；OAuth provisioning 通常会自动绑定它。 |
| OpenAI Chat 的 role 报错 | `/v1/chat/completions` 与 `/v1/messages` 是不同协议。前者接受 `system`、`developer`、`user`、`assistant`、`tool`；直接使用 Claude Code 时调用的是 Messages API，应遵循前一行的 Claude role 规则。 |

## 连接验证

在配置 Claude Code 前，可先确认服务、认证和 `sonnet` 映射：

```bash
curl http://127.0.0.1:3000/healthz

curl http://127.0.0.1:3000/v1/models \
  -H 'Authorization: Bearer sk-runtime-...'

curl http://127.0.0.1:3000/v1/messages \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer sk-runtime-...' \
  -d '{"model":"sonnet","max_tokens":64,"messages":[{"role":"user","content":"你好"}]}'
```

最后一个请求成功后，再以同一 Runtime API Key 启动 Claude Code。
