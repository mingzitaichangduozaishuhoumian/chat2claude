# 安装与升级 / Installation and upgrades

## 选择下载包

在 [Releases](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/releases/latest) 下载同一版本的文件：

| 文件 | 用途 |
| --- | --- |
| `chat2claude-v0.3.1-windows-x64.zip` | Windows 64 位免安装包，包含 Node.js；解压后运行 `start.bat`。 |
| `chat2claude-v0.3.1-node.zip` | 通用包，包含服务和生产依赖；需要预先安装受支持的 Node.js。 |
| `chat2claude-v0.3.1-node.tar.gz` | 与通用 ZIP 内容相同，适合 Linux/macOS 解压使用。 |
| `SHA256SUMS` | 上述下载文件的 SHA-256 校验值。 |

v0.3.1 发布包包含网页适配器、管理台与九项图片目录。网页默认关闭，自动模式默认优先 Codex。浏览器网关需独立部署并登录，再在管理台配置地址、检查连接，确认后勾选 **使用 ChatGPT 网页**并保存。保存地址和辅助命令都不会自动开启网页。`web-gateway:*` 辅助命令仅在[源码版](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/tree/v0.3.1)提供，不包含在发布包中；使用这些命令安装网关另需 Git、npm 和 Google Chrome，步骤见[网关安装说明](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/blob/v0.3.1/integrations/gpt-web-gateway/README.md)。主服务发布包仍无需 pnpm、npm 或自行安装依赖。

通用包推荐 Node.js 24 LTS，也支持 Node.js 22.15.0 以上的 22.x。无需安装 pnpm、下载依赖或编译源码。GitHub 自动附带的 **Source code** 是源码，仍需按 README 安装依赖并构建。

## 首次启动

1. 解压到可写目录，例如 `D:\Apps\chat2claude`。保留包内完整目录，不要只移动启动文件。
2. Windows 运行 `start.bat`；Linux/macOS 运行 `sh start.sh`。
3. 打开终端显示的地址，默认是 `http://127.0.0.1:3000/admin`。
4. 在后台授权你自己的 ChatGPT 账号，并生成客户端使用的 Runtime API Key。

服务默认监听本机，启动器默认使用 ChatGPT session 后端。首次运行会创建 `data/`，用于保存账号、Runtime Key 和设置。按 Ctrl+C 关闭服务；启动窗口需要保持运行。

包内 `release-manifest.json` 记录应用版本、源代码提交和运行时信息。Windows 包优先使用随包提供的 `runtime/node.exe`，不会替换系统 Node.js。

## 配置端口和代理

将包根目录的 `.env.example` 复制为 `.env`，按需修改；启动器会读取此文件，已有环境变量优先。例如：

```dotenv
PORT=3100
HOST=127.0.0.1
CHATGPT_BACKEND=session
# 如果本机代理实际监听该地址，再取消下一行的注释。
# OUTBOUND_PROXY_URL=http://127.0.0.1:7890
```

修改端口后，浏览器地址和客户端 Base URL 也要同步修改。完整参数见[使用说明](docs/USAGE.zh-CN.md)。

`.env` 和 `data/` 是本机私有配置，不包含在发布包内。不要将它们上传到 Issue 或代码仓库。若设置了 `STATE_ENCRYPTION_KEY`，升级时必须保留原值。

## 升级并保留账号

1. 停止旧服务，备份旧目录的 `.env` 和 `data/`；若设置了外部 `DATA_DIR`，备份该目录。
2. 将新版本解压到另一个空目录。
3. 将原 `.env` 和 `data/` 复制到新目录，再启动。使用外部 `DATA_DIR` 时继续指向原目录即可。
4. 确认后台账号、模型和 Runtime Key 正常后，再清理旧安装目录。

从源码版迁移时，默认数据目录是 `apps/api/data/`，复制其内容到新包的 `data/`。已有 `STATE_ENCRYPTION_KEY` 或其他环境配置同样需要保留。请勿同时运行两个实例写入同一数据目录。

升级保留已明确保存的网页开关和优先级；缺少 `webEnabled` 的旧配置按关闭处理。若此前已启用网页、现在希望只用 Codex，请在管理台关闭网页并保存，网关地址和 Key 会继续保留。

## 验证下载文件

Windows PowerShell：

```powershell
Get-FileHash .\chat2claude-v0.3.1-windows-x64.zip -Algorithm SHA256
```

将结果与同一 Release 的 `SHA256SUMS` 对照。Linux 可运行 `sha256sum -c SHA256SUMS --ignore-missing`；macOS 可运行 `shasum -a 256 chat2claude-v0.3.1-node.tar.gz` 并逐项对照。

如果端口已被占用，停止旧实例或更改 `PORT`。通用包提示 Node 版本不支持时，请安装 Node.js 24 LTS。遇到其他问题，请使用 [Discussions](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/discussions) 或阅读[支持说明](SUPPORT.md)。

## English

Download an archive and `SHA256SUMS` from the same [release](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/releases/latest).

- **Windows x64 ZIP:** includes Node.js. Extract the complete directory and run `start.bat`; it does not modify your system Node installation.
- **Node ZIP / TAR.GZ:** includes the compiled service and production dependencies. Install Node.js 24 LTS, or a supported Node.js 22.x version starting at 22.15.0, then run `start.bat` or `sh start.sh`. No pnpm or dependency installation is required.
- **Source code:** GitHub's automatically generated source archive requires the build steps in the README.

Version 0.3.1 archives include the Web adapter, Admin and nine image entries. Web defaults to off and Auto prefers Codex. Deploy and sign in to the browser gateway separately, configure its URL and check connectivity in Admin, then explicitly check **Use ChatGPT Web** and save. Saving a URL or running a helper does not enable Web. The `web-gateway:*` helpers are available only in the [source checkout](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/tree/v0.3.1), not in release archives; preparing the gateway with them also requires Git, npm and Google Chrome. See the [gateway installation guide](https://github.com/mingzitaichangduozaishuhoumian/chat2claude/blob/v0.3.1/integrations/gpt-web-gateway/README.md). The main service archives still require no pnpm, npm or dependency installation.

Open `http://127.0.0.1:3000/admin`, authorize your own ChatGPT account and create a Runtime API Key. The launcher defaults to the session backend and loopback networking. Keep the service running; Ctrl+C stops it.

Copy `.env.example` to `.env` to customize `PORT`, `HOST` or your actual outbound proxy. Existing environment variables take precedence. The default persistent directory is `data/` beside the launcher; `DATA_DIR` can point to an external directory. `release-manifest.json` identifies the packaged application, source commit and runtime.

To upgrade, stop the old service, back up `.env` and `data/`, extract the new version into a separate directory, copy your configuration/data, and verify the new instance before removing the old directory. Source installations store data in `apps/api/data/` by default. Preserve an existing `STATE_ENCRYPTION_KEY` and never run two instances against the same data directory.

Upgrades retain explicit Web switch and preference choices; legacy settings without `webEnabled` are treated as off. To stop using a previously enabled gateway, turn Web off in Admin and save. Its URL and Key remain configured.

Compare archive hashes with `SHA256SUMS`. On Windows use `Get-FileHash -Algorithm SHA256`; on Linux use `sha256sum -c SHA256SUMS --ignore-missing`; on macOS use `shasum -a 256 <archive>`. See [SUPPORT.md](SUPPORT.md) for help and [the usage guide](docs/USAGE.en.md) for full configuration details. Do not include private `.env`, account state or tokens in support reports.
