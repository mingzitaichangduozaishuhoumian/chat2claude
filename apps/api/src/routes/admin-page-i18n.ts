export type AdminLocale = 'zh-CN' | 'en';

// Source-language keys keep copy shared by SSR, browser renderers and feedback.
// Protocol identifiers and provider payloads are not translation keys.
export const ADMIN_MESSAGES: Record<string, string> = {
  '上游套餐': 'Provider plan',
  '套餐未知': 'Plan unknown',
  '套餐来自陈旧观察': 'Plan from a stale observation',
  '配额操作': 'Quota actions',
  '刷新此账号配额': 'Refresh this account quota',
  '消耗一次上游重置次数': 'Consume one provider reset credit',
  '主动重置': 'Active reset',
  '上游重置次数': 'Provider reset credits',
  '可用重置次数': 'Available reset credits',
  '缓存到期：': 'Cache expires: ',
  '重置次数到期：': 'Reset credit expires: ',
  '· 发放：': ' · Granted: ',
  '上游未返回重置次数。': 'The provider did not return a reset-credit balance.',
  '重置次数读取失败，余额未知；请刷新后重试。': 'Reset-credit lookup failed; balance unknown. Refresh and try again.',
  '主动重置消耗 1 次上游重置次数，不改变本地冷却。缓存到期、配额窗口重置与重置次数到期互不相同。': 'Active reset consumes one provider credit without changing local cooldown. Cache expiry, quota-window reset, and credit expiry are separate.',
  '确认消耗此账号的 1 次上游重置次数？这将主动重置 Codex 配额，不是清除本地冷却。成功后会重新读取完整上游配额，无法撤销。': 'Consume one provider reset credit for this account? This actively resets Codex quota, not local cooldown. Full provider quota will be fetched after success. This cannot be undone.',
  '正在消耗上游重置次数并刷新配额。': 'Consuming a provider reset credit and refreshing quota.',
  '配额管理认证已失效。请重新打开本机 /admin 恢复会话，或自行前往“管理访问”更新 Admin API Key，然后在此重试。': 'Quota admin authentication expired. Reopen local /admin to restore your session, or visit Admin Access yourself to update the Admin API Key, then retry here.',
  '上游已接受主动重置，但完整配额刷新失败。请先刷新配额，不要重复消耗重置次数。': 'The provider accepted the reset, but full quota refresh failed. Refresh quota before consuming another credit.',
  '配额操作失败。请刷新配额后重试；缓存未被本地扣减。': 'Quota operation failed. Refresh quota before retrying; no local balance decrement was made.',
  '直接接入 Claude Code（推荐）': 'Connect directly to Claude Code (recommended)',
  '通过 CC Switch 接入（可选）': 'Connect via CC Switch (optional)',
  '复制 Claude Code 配置': 'Copy Claude Code configuration',
  '复制 CC Switch 配置': 'Copy CC Switch configuration',
  '无需第三方工具。将以下 env 合并到 Claude Code 的 ~/.claude/settings.json，保留已有设置，然后重启 Claude Code。': 'No third-party tool is required. Merge the env below into ~/.claude/settings.json, preserve existing settings, then restart Claude Code.',
  'Base URL：': 'Base URL: ',
  '配置仅使用本次显示的 Runtime API Key；未显示时请替换占位符，不能使用 Admin API Key。清除显示会同时清除下方配置中的 Key。': 'Configuration uses only the Runtime API Key currently shown. Otherwise, replace the placeholder; never use the Admin API Key. Clearing the display also removes the key from the configurations below.',
  '模型 alias：haiku、sonnet、fable、opus。调用前请在模型映射中绑定后端；可使用 /model fable 切换到 Fable。': 'Model aliases: haiku, sonnet, fable, opus. Bind backends in Models before calling them; use /model fable to select Fable.',
  'CC Switch 仅是可选配置管理工具，不是必需项，也不是本项目依赖。已有 Claude Code 直连配置时无需安装。': 'CC Switch is an optional configuration manager, not a requirement or a project dependency. No installation is needed if Claude Code is already configured directly.',
  '在 CC Switch 中选择 Claude Code，新增自定义供应商，将以下 JSON 粘贴到供应商配置编辑器，保存并启用。Base URL 使用站点根地址，不追加 /v1。': 'In CC Switch, select Claude Code, add a custom provider, paste the JSON below into its configuration editor, then save and enable it. Use the site root as Base URL without appending /v1.',
  '配置已复制；请安全保存，并替换尚未填写的 Runtime Key 占位符。': 'Configuration copied. Save it securely and replace any remaining Runtime Key placeholder.',
  '复制失败，请手动选中配置并复制。': 'Copy failed. Select and copy the configuration manually.',
  '重置：': 'Reset: ', '上游未返回百分比，不显示零值进度条。重置：': 'No percentage returned upstream; no zero-value progress bar is shown. Reset: ',
  '{0}（陈旧观察）': '{0} (stale observation)',
  'reasoning: {0}; service tiers: 未知': 'reasoning: {0}; service tiers: unknown',
  '诊断数据': 'Diagnostic data', '最近发现尝试：': 'Last discovery attempt: ', '· 最近成功：': ' · Last success: ', '最后获取：': 'Last fetched: ',
  '：未绑定，请在下方模型映射中选择后端模型并保存': ': Unbound; choose and save a backend model below',
  '打开 /admin 点击“浏览器授权（Codex OAuth）”，新标签页会直接打开授权页；若被拦截可点击链接或复制 URL，完成后系统会自动初始化账号、模型和 API Key。': 'Open Accounts & Authorization and start Codex OAuth in a new tab. If the popup is blocked, open or copy the link. Completing authorization initializes the account, models, and API Key.',
  'ChatGPT session 已导入。请复制 API 配置调用 /v1/messages。': 'ChatGPT session imported. Copy the API configuration to call /v1/messages.',
  '请在新窗口完成 Codex OAuth 授权；本地 localhost:{0} callback listener 会通过可用的 IPv6/IPv4 loopback 接收回调。': 'Complete Codex OAuth in the new window. The localhost:{0} callback listener receives the callback over an available IPv6/IPv4 loopback.',
  '请打开或复制 Codex OAuth 授权链接完成授权。授权后如果浏览器显示无法连接 localhost:{0}，请复制地址栏 callback URL 回后台粘贴。': 'Open or copy the Codex OAuth link. If the browser cannot connect to localhost:{0} after authorization, copy the callback URL from the address bar and paste it here.',
  '本地 callback listener 未能启动。': 'The local callback listener could not start.',
  'Codex OAuth 授权失败，请重新授权。': 'Codex OAuth authorization failed. Authorize again.',
  '请在浏览器完成 Codex OAuth 授权；如果 localhost:{0} callback 失败，请把浏览器地址栏里的完整 callback URL 粘贴到后台。': 'Complete Codex OAuth in your browser. If the localhost:{0} callback fails, paste the complete address-bar callback URL here.',
  '正在健康检查、刷新模型并生成 API Key。': 'Checking health, refreshing models, and generating the API Key.',
  '授权流程已取消。': 'Authorization flow cancelled.',
  '正在通过 OpenAI Codex OAuth token endpoint 换取访问 token。': 'Exchanging the authorization code at the OpenAI Codex OAuth token endpoint.',
  'Codex OAuth 授权成功，正在自动初始化。': 'Codex OAuth authorization succeeded. Initializing automatically.',
  'Codex OAuth token exchange 失败，可重新授权或使用高级手动导入。': 'Codex OAuth token exchange failed. Authorize again or use advanced manual import.',
  'ChatGPT 授权和 API 初始化已完成。': 'ChatGPT authorization and API setup complete.',
  '授权流程已过期，请重新点击浏览器授权。': 'Authorization flow expired. Start browser authorization again.',
  '自动初始化失败，可重新授权或使用高级手动导入。': 'Automatic setup failed. Authorize again or use advanced manual import.',
  '请重新授权；如果仍失败，请确认账号可使用 Codex。': 'Authorize again. If it still fails, confirm that your account can use Codex.',
  '请重新授权后重试模型准备。': 'Authorize again, then retry model preparation.',
  '请重试；若持续失败，请检查本地运行状态。': 'Retry. If failures persist, check the local service.',
  '自动初始化在会话验证/模型发现阶段失败{0}。{1}': 'Automatic setup failed during session validation/model discovery{0}. {1}',
  '自动初始化在模型准备阶段失败{0}。{1}': 'Automatic setup failed during model preparation{0}. {1}',
  '自动初始化在状态提交阶段失败{0}。{1}': 'Automatic setup failed while committing state{0}. {1}',
  '用于本人控制或已获明确授权的 ChatGPT/Codex 账号。认证生命周期与 provider 配额观测相互独立，禁止用于公开转售订阅流量或面向不特定第三方的大规模共享。': 'For ChatGPT/Codex accounts you control or are explicitly authorized to use. Authorization lifecycle and provider quota observation are independent. Do not publicly resell subscription traffic or share it at scale with unspecified third parties.',
  '个人自托管控制台': 'Personal hosting console',
  'chat2claude 个人自托管控制台': 'chat2claude · Personal hosting console',
  '管理界面模式': 'Console mode', '界面语言': 'Interface language', 'Admin 模块': 'Console destinations',
  '简洁模式': 'Simple', '专业模式': 'Professional', '运行': 'Operations', '网关': 'Gateway', '观测': 'Observability', '管理': 'Administration',
  '概览': 'Overview', '账号与授权': 'Accounts & Authorization', '模型映射': 'Models', 'API 接入': 'API Access', '配额': 'Quotas', '管理访问': 'Admin Access',
  '来自现有缓存的运行摘要。最近账号活动不是完整请求日志。': 'Operational summary from existing caches. Recent account activity is not a complete request log.',
  '正在读取运行摘要。': 'Loading operational summary.',
  '管理浏览器授权与账号健康。手动凭据导入仅作为专业模式的备用入口。': 'Manage browser authorization and account health. Manual credential import is a professional-mode fallback only.',
  '选择已发现的后端模型，并为客户端配置稳定的 alias。': 'Choose discovered backend models and configure stable client aliases.',
  '使用独立的 Runtime API Key 连接客户端；Base URL 不包含 /v1。': 'Connect clients with a separate Runtime API Key. The Base URL does not include /v1.',
  '优先使用本机 HttpOnly 管理会话。Admin API Key 仅用于服务已由操作者自行连通后的外部管理。': 'Prefer the host-local HttpOnly admin session. Use an Admin API Key for external management only after the operator has independently made the service reachable.',
  '客户端配置': 'Client configuration', '将 Base URL 与安全保存的 Runtime API Key 填入客户端，模型可使用 sonnet。': 'Enter the Base URL and your securely saved Runtime API Key in your client. You can use the sonnet model.',
  '添加 ChatGPT 账号': 'Add ChatGPT account', '浏览器授权（Codex OAuth）': 'Browser authorization (Codex OAuth)',
  '不会启动独立 Chrome/新 profile；主按钮会在当前浏览器打开授权页。': 'Opens authorization in your current browser, without a separate Chrome profile.',
  '已配置': 'Configured', '待初始化': 'Not initialized', '检测中': 'Checking',
  '正在验证本地管理会话': 'Verifying local admin session',
  '推荐在本机浏览器使用 HttpOnly 会话；无需 Admin API Key。': 'Use the HttpOnly session in a host-local browser when possible; no Admin API Key is needed.',
  '高级：外部管理访问（Admin API Key）': 'Advanced: external management access (Admin API Key)',
  '优先在本机浏览器使用 HttpOnly 会话。只有操作者自行通过 LAN、VPN/mesh VPN、SSH 隧道、反向隧道/NAT 穿透或反向代理使服务可达后，才从其他浏览器、设备或自动化使用此 Key；本项目不创建隧道、不配置 NAT、也不发布服务。': 'Prefer the HttpOnly session in a host-local browser. Use this key from another browser, device, or automation only after the operator independently makes the service reachable through LAN, VPN/mesh VPN, an SSH tunnel, reverse tunnel/NAT traversal, or reverse proxy; this project creates no tunnel, configures no NAT, and does not publish the service.',
  'Admin API Key 授予完整管理权限，不要作为普通用户、Claude 或 API 凭据分享；普通客户端应使用 Runtime API Key。当前受保护 Admin API 仍接受有效 Runtime/API_KEYS，因此这是签发/使用区分，不是硬权限边界。Key 默认只保留在当前页面，勾选后才明确保存到此浏览器（localStorage）。': 'An Admin API Key grants full management access. Do not share it as a normal user, Claude, or API credential; normal clients should receive Runtime API Keys. Protected Admin APIs still accept valid Runtime/API_KEYS, so this is an issuance/use distinction, not a hard privilege boundary. The key stays on this page unless you explicitly opt into browser storage (localStorage).',
  '仅本页启用 Key': 'Use key on this page', '明确保存到此浏览器（localStorage）': 'Explicitly save in this browser (localStorage)',
  '当前 backend：': 'Current backend: ', '授权 ChatGPT': 'Authorize ChatGPT', '取消': 'Cancel',
  '打开 Codex OAuth 授权页': 'Open Codex OAuth authorization', '复制授权链接': 'Copy authorization link',
  '如果授权完成后浏览器显示无法连接本地 callback（默认 1455，必要时自动使用 1457），请原样复制地址栏完整 URL。': 'If the browser cannot connect to the local callback after authorization (port 1455, or 1457 when needed), copy the complete address-bar URL unchanged.',
  'OAuth callback URL（请粘贴完整 callback URL）': 'OAuth callback URL (paste the complete URL)',
  '粘贴完整 localhost callback URL': 'Paste the complete localhost callback URL', '提交 callback URL': 'Submit callback URL',
  '正常流程': 'Getting connected', '浏览器授权': 'Browser authorization', '点击后打开 Codex OAuth；链接可点击打开，也可复制。': 'Open Codex OAuth. You can also open or copy the authorization link.',
  '自动初始化': 'Automatic setup', '创建账号、检查健康并刷新该账号动态模型。': 'Creates the account, checks health, and discovers its models.',
  '保存 Runtime Key': 'Save your Runtime Key', '原始 Key 仅在首次生成时显示一次。': 'The raw key is shown once, when first generated.',
  '认证账号': 'Authorized accounts', '个人账号池（高级）': 'Personal account pool (advanced)',
  '简洁模式展示身份、套餐、启用、健康、请求结果、最近活动和模型数；专业模式增加内部诊断字段与完整动态模型。': 'Simple mode shows identity, plan, health, request outcomes, activity, and models. Professional mode adds diagnostics and the full model catalog.',
  '正在读取账号状态。': 'Loading account status.', '高级：手动导入 accessToken / cookie': 'Advanced: import accessToken / cookie manually',
  '这不是正常流程。仅在 OAuth 无法使用或已有 session secret 时展开；表单不会返回 token/cookie。': 'This is a fallback, not the normal flow. Use only when OAuth is unavailable or you already have a session secret. Tokens and cookies are never returned.',
  '导入模式': 'Import mode', '新增账号': 'Add account', '重新授权已有账号': 'Reauthorize existing account', '目标账号': 'Target account',
  '请选择 session 账号': 'Choose a session account', 'Cookie（可选）': 'Cookie (optional)', 'Device ID（可选）': 'Device ID (optional)', 'User Agent（可选）': 'User Agent (optional)', '导入并初始化': 'Import and initialize',
  '内置模型 Alias': 'Built-in model aliases',
  'Sonnet 会在首次授权时自动选择后端。Haiku、Fable 和 Opus 如显示“未绑定”，请在下方模型映射中选择后端模型并保存后再调用；简洁模式即可完成绑定。': 'Sonnet selects a backend on first authorization. If Haiku, Fable, or Opus is unbound, choose and save a backend model below before calling it. Binding is available in simple mode.',
  '正在读取 alias 状态。': 'Loading alias status.',
  '客户端调用': 'Client calls to ',
  '使用的独立凭据，不是 Admin API Key。生成新 Key 不会撤销现有 Key；生成后的 Key 会固定保存，跨浏览器和服务重启保持有效，直至显式撤销。原始值只在本页面本次显示，请立即复制保存。当前': ' use separate credentials, not the Admin API Key. Generating a new key does not revoke existing keys. Keys persist across browsers and server restarts until explicitly revoked. The raw value is shown only once on this page; copy and save it now. Current count: ',
  '个；列表只显示安全前缀。': '; the list shows safe prefixes only.',
  '生成新 Key': 'Generate new key', '刷新 Key 列表': 'Refresh key list', '新生成的 Runtime API Key（仅本次显示）': 'New Runtime API Key (shown once)',
  '复制 Runtime API Key': 'Copy Runtime API Key', '清除显示': 'Clear display', '正在读取 Runtime API Key。': 'Loading Runtime API Keys.',
  '简洁模式可选择 Backend Model、启用并保存；专业模式增加推理、服务层级和自定义 alias 管理。选项仅来自 backend discovery。': 'Choose a backend model, enable it, and save in simple mode. Professional mode adds reasoning, service tiers, and custom aliases. Options come only from backend discovery.',
  '重置 alias overlay': 'Reset alias overlay', '刷新 backend discovery': 'Refresh backend discovery', '新 alias，例如 research': 'New alias, e.g. research', '新模型 alias': 'New model alias',
  '显示名称（可选）': 'Display name (optional)', '模型显示名称': 'Model display name', '未绑定（可选）': 'Unbound (optional)', '创建自定义 alias': 'Create custom alias', '正在加载模型映射。': 'Loading model mappings.',
  'API 配置': 'API configuration', '将上方一次性显示的 Runtime API Key 安全保存后，再替换此示例中的占位符。': 'Securely save the one-time Runtime API Key above, then replace the placeholder in this example.',
  '结果面板': 'Operation results', 'curl 示例': 'cURL example', '示例地址由当前页面 origin 生成。': 'Example URLs use this page’s origin.',
  '独立读取 ChatGPT provider 返回的 allowance 与时间窗口。五小时和每周窗口只按返回时长识别；其他 meter 原样逐项展示，缺失不会显示为 0%。': 'Independently reads allowance and windows returned by the ChatGPT provider. Five-hour and weekly windows are identified by duration; other meters are shown individually. Missing usage is never shown as 0%.',
  '刷新全部配额': 'Refresh all quotas', 'Provider 配额': 'Provider quotas',
  '页面首次加载只读取缓存，不触发上游请求。刷新操作按账号去重；批量刷新允许部分成功。': 'Initial load reads the cache only, without upstream requests. Refreshes are deduplicated per account; bulk refresh may partially succeed.',
  '正在读取配额缓存。': 'Loading quota cache.',
  '尚未添加 ChatGPT 账号': 'No ChatGPT accounts yet', '使用“添加 ChatGPT 账号”完成正常的浏览器授权流程。': 'Use “Add ChatGPT account” to complete browser authorization.',
  '暂无配额结果': 'No quota results yet', '配额结果由 provider allowance 查询独立提供；添加账号后可刷新。': 'Quota results come independently from provider allowance queries. Refresh after adding an account.',
  '尚未发现动态模型': 'No models discovered yet', '套餐': 'Plan', '启用': 'Enable', '已启用': 'Enabled', '已停用': 'Disabled', '模型': 'Models', '最近活动': 'Last activity',
  '5x/20x 是套餐类别标识，不代表当前剩余额度。': '5x/20x identifies plan categories, not remaining allowance.',
  '请求结果统计': 'Request outcomes', '成功 {0}': 'Succeeded {0}', '失败 {0}': 'Failed {0}', '取消 {0}': 'Cancelled {0}', '总计 {0}': 'Total {0}',
  '内部 ID': 'Internal ID', '上游 ID': 'Upstream ID', '凭据到期': 'Credential expiry', '并发': 'Concurrency', '冷却至': 'Cooldown until', '安全错误码': 'Safe error code',
  '不可用': 'Unavailable', '无': 'None', '最近发现尝试：{0} · 最近成功：{1}': 'Last discovery attempt: {0} · Last success: {1}',
  '安全发现诊断：': 'Safe discovery diagnostics: ', '动态模型完整列表（{0}）': 'Full discovered model catalog ({0})', '{0} 账号操作': '{0} account actions',
  '刷新健康与模型': 'Refresh health & models', '重新授权': 'Reauthorize', '停用': 'Disable', '设置': 'Settings', '删除': 'Delete', '账号有进行中的请求': 'Account has requests in flight',
  '账号标签': 'Account label', '最大并发': 'Maximum concurrency', '保存设置': 'Save settings',
  'Provider allowance 未知': 'Provider allowance unknown', '仅展示上游返回的 allowance 与 meter，不从套餐、429 或请求统计推断。': 'Only upstream allowance and meters are shown, never inferred from plans, 429s, or request statistics.',
  '五小时窗口': 'Five-hour window', '每周窗口': 'Weekly window', '五小时窗口不可用': 'Five-hour window unavailable', '每周窗口不可用': 'Weekly window unavailable',
  '其他上游窗口': 'Other upstream windows', '此账号不支持配额查询': 'Quota lookup unsupported for this account', '当前 provider 或账号类型不提供 quota lookup；无法刷新此账号配额。': 'This provider or account type does not offer quota lookup; its quota cannot be refreshed.',
  '最后获取：{0}': 'Last fetched: {0}', '状态详情：{0}': 'Status details: {0}', '刷新此账号': 'Refresh this account', '附加额度 {0}': 'Additional allowance {0}',
  '可用': 'Available', '状态未知': 'Unknown status', '上游未返回 meter 窗口': 'No meter windows returned upstream', '时长未知': 'Unknown duration', '重置时间未知': 'Unknown reset time',
  '用量未知 · {0}': 'Unknown usage · {0}', '上游未返回百分比，不显示零值进度条。重置：{0}': 'No percentage returned upstream; no zero-value progress bar is shown. Reset: {0}',
  '已用 {0}% · 剩余 {1}%': 'Used {0}% · Remaining {1}%', '{0} 已用 {1}%': '{0} used {1}%', '已用 {0}%，剩余 {1}%': 'Used {0}%, remaining {1}%', '{0} · 重置：{1}': '{0} · Reset: {1}',
  '上游响应中没有该时长窗口': 'No window of this duration in the upstream response', '健康': 'Healthy', '冷却中': 'Cooling down', '异常': 'Unhealthy', '尚未获取': 'Not fetched', '数据新鲜': 'Fresh data', '数据陈旧': 'Stale data', '获取失败': 'Fetch failed',
  'Provider allowance：不可用': 'Provider allowance: unavailable', 'Provider allowance：可用': 'Provider allowance: available', 'Provider allowance：未知': 'Provider allowance: unknown',
  '{0} 周': '{0} weeks', '{0} 天': '{0} days', '{0} 小时': '{0} hours', '{0} 分钟': '{0} minutes', '{0} 秒': '{0} seconds',
  '相对时间未知': 'Unknown relative time', '已到重置时间': 'Reset time reached', '{0} 秒后': 'in {0} seconds', '{0} 分钟后': 'in {0} minutes', '{0} 小时后': 'in {0} hours', '{0} 天后': 'in {0} days',
  '（陈旧观察）': ' (stale observation)',
  '最新刷新失败，继续使用 {0} 个缓存模型': 'Latest refresh failed; using {0} cached models', '模型响应格式不兼容；尚无已验证目录': 'Incompatible model response; no verified catalog', '模型发现失败；尚无已验证目录': 'Model discovery failed; no verified catalog',
  '上游明确返回空目录': 'Upstream explicitly returned an empty catalog', '已接受 {0} 个账号级模型；部分条目被安全忽略': 'Accepted {0} account models; some entries were safely ignored', '已发现 {0} 个账号级模型': 'Discovered {0} account models', '发现状态未知；保留 {0} 个缓存模型': 'Discovery status unknown; retaining {0} cached models', '模型发现状态未知；尚无已验证目录': 'Discovery status unknown; no verified catalog',
  'Admin API Key 已明确保存到此浏览器。': 'Admin API Key explicitly saved in this browser.', 'Admin API Key 仅在当前页面启用；刷新或关闭后不会保留。': 'Admin API Key enabled only on this page; it will not survive reload or closing.', 'Admin API Key 已清除。': 'Admin API Key cleared.',
  '浏览器拦截了授权窗口，请点击下方“打开 Codex OAuth 授权页”或复制授权链接。': 'The browser blocked the popup. Open the Codex OAuth link below or copy it.', '已取消。': 'Cancelled.', '授权链接已复制，请在当前浏览器中打开。': 'Authorization link copied. Open it in your current browser.', '复制失败，请手动选中下方完整授权 URL 复制。': 'Copy failed. Select and copy the complete authorization URL below.',
  '一次性 Runtime API Key 显示已清除。': 'One-time Runtime API Key display cleared.', '已生成新的 Runtime API Key；现有 Key 保持有效。': 'New Runtime API Key generated; existing keys remain valid.', '请粘贴完整 callback URL。': 'Paste the complete callback URL.', '请选择需要重新授权的 session 账号。': 'Choose the session account to reauthorize.', '服务重启或流程过期，请重新授权。': 'The server restarted or the flow expired. Authorize again.', 'OAuth 操作失败：{0}': 'OAuth operation failed: {0}',
  '初始化完成：已创建账号并生成 Runtime API Key，请立即复制保存。': 'Setup complete: account created and Runtime API Key generated. Copy and save it now.', '授权完成：账号凭据已更新，现有 Runtime API Key 保持有效且不会再次显示原始值。': 'Authorization complete: account credentials updated. Existing Runtime API Keys remain valid and their raw values will not be shown again.',
  '请立即复制保存；关闭或清除显示后无法恢复原始 Key。': 'Copy and save now; the raw key cannot be recovered after closing or clearing this display.', '已复制到剪贴板。请立即保存；刷新页面后不会再次显示原始 Key。': 'Copied to clipboard. Save now; the raw key will not be shown after reload.', 'Runtime API Key 已复制。': 'Runtime API Key copied.', '剪贴板不可用，请手动选中上方完整 Key 并立即保存。': 'Clipboard unavailable. Select the complete key above and save it now.', 'Runtime API Key 复制失败，请手动选中并立即保存。': 'Runtime API Key copy failed. Select and save it manually now.',
  '账号数据加载失败，未加载。': 'Account data failed to load.', '正在刷新': 'Refreshing', '确认删除此账号？账号凭据、动态模型关联和配额缓存将被移除，操作无法恢复。': 'Delete this account? Credentials, model associations, and quota cache will be removed. This cannot be undone.',
  '配额数据加载失败': 'Quota data failed to load', '未知错误': 'Unknown error', '重试配额加载': 'Retry loading quotas',
  '此账号不支持配额查询，无法刷新。': 'Quota lookup unsupported for this account; refresh is unavailable.', '账号配额刷新成功，数据为新鲜状态。': 'Account quota refreshed successfully; data is fresh.', '账号配额刷新完成，但返回的是陈旧数据。': 'Account quota refresh completed, but data is stale.', '账号配额刷新完成，但上游返回错误状态。': 'Account quota refresh completed, but the provider returned an error.', '账号配额刷新完成，但上游未返回可用状态。': 'Account quota refresh completed, but the provider returned no usable status.', '账号配额刷新完成，但返回了未知配额状态。': 'Account quota refresh completed with an unrecognized status.',
  '正在刷新账号配额。': 'Refreshing account quota.', '账号配额刷新失败。': 'Account quota refresh failed.', '正在刷新全部账号配额。': 'Refreshing all account quotas.', '全部配额刷新完成，但结果不完整。新鲜 {0}，陈旧 {1}，错误 {2}，未知 {3}。': 'Bulk refresh completed with incomplete results. Fresh {0}, stale {1}, error {2}, unknown {3}.', '全部账号配额刷新成功。新鲜 {0}。': 'All account quotas refreshed. Fresh {0}.', '全部账号配额刷新失败。': 'Bulk account quota refresh failed.',
  '名称': 'Name', '安全前缀': 'Safe prefix', '创建时间': 'Created', '操作': 'Actions', '撤销': 'Revoke', '没有运行时 API Key。': 'No Runtime API Keys.', '确认撤销此运行时 API Key？撤销后对应客户端会立即失效。': 'Revoke this Runtime API Key? Clients using it will stop working immediately.', '运行时 API Key 加载失败，未加载。': 'Runtime API Keys failed to load.',
  'Backend discovery 暂无模型；不会假设所有控制项都可用。': 'No models in backend discovery; controls are not assumed available.', 'Backend discovery（选项与顺序直接来自 catalog）': 'Backend discovery (options and order come from the catalog)', '未绑定，请在下方模型映射中选择后端模型并保存': 'Unbound; choose and save a backend model below', '暂无内置 alias。': 'No built-in aliases.', '状态': 'Status', '目标能力与默认参数': 'Target capabilities & defaults', '内置': 'Built-in', 'Alias {0} 的 Backend Model': 'Backend model for alias {0}', 'Alias {0} 是否启用': 'Enable alias {0}', '保存': 'Save', '暂无 alias overlay。': 'No alias overlay.', '模型数据加载失败，未加载。': 'Model data failed to load.', '确认删除此自定义模型 alias？删除后无法恢复。': 'Delete this custom model alias? This cannot be undone.',
  '{0}（已失效）': '{0} (no longer available)', '未绑定': 'Unbound', 'Standard（发送 service_tier: default）': 'Standard (sends service_tier: default)', 'Auto（省略 service_tier）': 'Auto (omits service_tier)', 'Fast（配置不受目标支持）': 'Fast (unsupported by target)', '推理': 'Reasoning', '服务层级': 'Service tier', '{0}（配置不受目标支持）': '{0} (unsupported by target)', 'Light（官方 low）': 'Light (official low)', 'Ultra（兼容最高强度）': 'Ultra (compatible maximum effort)',
  '推理元数据：已发现': 'Reasoning metadata: discovered', '推理元数据：未知': 'Reasoning metadata: unknown', '服务层级元数据：已发现': 'Service tier metadata: discovered', '服务层级元数据：未知': 'Service tier metadata: unknown', 'Ultra 会有损映射到 {0}，不会把 ultra 发给上游': 'Ultra maps lossily to {0}; ultra is never sent upstream', 'Ultra 没有安全的非 ultra 映射；显式请求会拒绝，隐式默认会省略': 'Ultra has no safe non-ultra mapping; explicit requests are rejected and implicit defaults omitted', '未知': 'Unknown',
  '未认证/数据未加载。请使用高级“外部管理访问（Admin API Key）”后重试。': 'Not authenticated; data not loaded. Use Advanced external management access (Admin API Key) and retry.',
  '本地会话已连接': 'Local session connected', '管理操作已通过 HttpOnly 浏览器会话完成': 'Management uses an HttpOnly browser session', '此页面无需 Admin API Key。会话仅适用于本机可信访问，服务重启或会话失效后会自动回退到显式 Key。': 'No Admin API Key needed here. The session is for trusted local access only; server restart or expiry falls back to an explicit key.', '需要显式 Key': 'Explicit key required', '未检测到可用的本地管理会话': 'No usable local admin session detected', '远程访问、自动化或会话失效时，请展开 fallback 并手动提供 Admin API Key。': 'For remote access, automation, or an expired session, expand the fallback and enter an Admin API Key.',
  '账号健康': 'Account health', '已发现模型': 'Discovered models', '可用 alias': 'Available aliases', 'Runtime Key 数量': 'Runtime Key count', '配额缓存': 'Quota cache', '接入状态': 'Access status', '下一步': 'Next step', '最近账号活动': 'Recent account activity', '尚无账号活动。': 'No account activity yet.',
  '尚未加载': 'Not loaded', '加载中': 'Loading', '加载失败；保留上次缓存': 'Load failed; retaining last cache', '已加载': 'Loaded', '无数据': 'No data',
  '新鲜 {0} · 陈旧 {1} · 错误 {2} · 未知 {3}': 'Fresh {0} · Stale {1} · Error {2} · Unknown {3}',
  '健康 {0} · 异常 {1} · 停用 {2}': 'Healthy {0} · Unhealthy {1} · Disabled {2}',
  '先添加账号并完成浏览器授权。': 'Add an account and complete browser authorization first.', '检查模型映射并生成客户端 Runtime Key。': 'Check model mappings and generate a client Runtime Key.',
  '最近活动来自账号时间戳和累计请求结果，不是完整请求日志。': 'Recent activity uses account timestamps and cumulative outcomes, not a complete request log.',
};

export function normalizeAdminLocale(value: unknown): AdminLocale {
  return value === 'en' ? 'en' : 'zh-CN';
}

export function translate(key: string, locale: AdminLocale = 'zh-CN', values: Array<string | number> = []): string {
  const message = locale === 'en' && Object.prototype.hasOwnProperty.call(ADMIN_MESSAGES, key) ? ADMIN_MESSAGES[key] : key;
  return message.replace(/\{(\d+)\}/g, (match, index: string) => String(values[Number(index)] ?? match));
}

/** Matches only complete authored messages. Unknown provider text stays verbatim. */
export function translateAdminText(text: string, locale: AdminLocale = 'zh-CN'): string {
  if (!text.trim()) return text;
  const value = text.trim();
  const duration = value.match(/^(\d+(?:\.\d+)?) (周|天|小时|分钟|秒)$/);
  let translated = duration ? formatAdminDurationUnit(Number(duration[1]), duration[2], locale)
    : Object.prototype.hasOwnProperty.call(ADMIN_MESSAGES, value) ? (locale === 'en' ? ADMIN_MESSAGES[value] : value) : undefined;
  if (translated === undefined) {
    for (const [key, message] of Object.entries(ADMIN_MESSAGES)) {
      if (!key.includes('{')) continue;
      const pattern = key.split(/\{\d+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+?)');
      const match = value.match(new RegExp('^' + pattern + '$'));
      if (match) {
        translated = (locale === 'en' ? message : key).replace(/\{(\d+)\}/g, (_token, index: string) => {
          const part = match[Number(index) + 1];
          const numericMessage = ['成功 {0}', '失败 {0}', '取消 {0}', '总计 {0}', '健康 {0} · 异常 {1} · 停用 {2}', '新鲜 {0} · 陈旧 {1} · 错误 {2} · 未知 {3}'].includes(key);
          if (numericMessage && /^\d+(?:\.\d+)?$/.test(part)) return formatAdminNumber(Number(part), locale);
          return key.startsWith('{0}') || key.startsWith('Alias ') ? part : translateAdminText(part, locale);
        });
        break;
      }
    }
  }
  // Composite metadata is authored as independently translatable clauses.
  if (translated === undefined && value.includes(' · ')) translated = value.split(' · ').map((part) => translateAdminText(part, locale)).join(' · ');
  return translated === undefined ? text : text.slice(0, text.indexOf(value)) + translated + text.slice(text.indexOf(value) + value.length);
}

export function formatAdminDate(value: string | null | undefined, locale: AdminLocale = 'zh-CN'): string {
  if (!value) return translate('不可用', locale);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale, { hour12: false });
}

export function formatAdminNumber(value: number, locale: AdminLocale = 'zh-CN'): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
}

function formatAdminDurationUnit(value: number, unit: string, locale: AdminLocale): string {
  const englishUnits: Record<string, string> = { '周': 'week', '天': 'day', '小时': 'hour', '分钟': 'minute', '秒': 'second' };
  if (locale === 'en') return new Intl.NumberFormat(locale, {
    style: 'unit', unit: englishUnits[unit], unitDisplay: 'long', maximumFractionDigits: 1,
  }).format(value);
  return `${formatAdminNumber(value, locale)} ${unit}`;
}

export function formatAdminDuration(seconds: number, locale: AdminLocale = 'zh-CN'): string {
  const units: Array<[number, string]> = [[604800, '周'], [86400, '天'], [3600, '小时'], [60, '分钟'], [1, '秒']];
  const [size, unit] = units.find(([size]) => seconds !== 0 && seconds % size === 0) ?? units[4];
  return formatAdminDurationUnit(seconds / size, unit, locale);
}

export function serializeAdminData(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// Keep this at module scope so tsx does not inject a local function-name helper.
function renderAdminMarkupText(text: string, locale: AdminLocale): string {
  const decoded = text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity] ?? entity);
  return translateAdminText(decoded, locale).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

/** Localizes our generated markup, never raw payloads. Inputs are already HTML-escaped. */
export function localizeAdminMarkup(html: string, locale: AdminLocale = 'zh-CN'): string {
  if (locale === 'zh-CN') return html;
  html = html.replace(/(<time data-admin-date="([^"]*)">)[^<]*(<\/time>)/g, (_match, open: string, date: string, close: string) => open + formatAdminDate(date, locale) + close);
  html = html.replace(/(<span data-admin-number="([\d.]+)">)[^<]*(<\/span>)/g, (_match, open: string, value: string, close: string) => open + formatAdminNumber(Number(value), locale) + close);
  const stack: boolean[] = [];
  return html.replace(/<[^>]*>|[^<]+/g, (token) => {
    if (token.startsWith('</')) { stack.pop(); return token; }
    if (token.startsWith('<')) {
      const name = token.match(/^<([\w-]+)/)?.[1] ?? '';
      const ignored = Boolean(stack.at(-1)) || /^(script|style|code|pre)$/.test(name) || token.includes('data-i18n-ignore');
      if (!/^(input|br|hr|meta|link|img|wbr)$/.test(name)) stack.push(ignored);
      return ignored ? token : token.replace(/(aria-label|aria-valuetext|title|placeholder)="([^"]*)"/g, (_match, attr: string, value: string) => `${attr}="${renderAdminMarkupText(value, locale)}"`);
    }
    return stack.at(-1) ? token : renderAdminMarkupText(token, locale);
  });
}

// All referenced functions are emitted with stable local names, not bundler imports.
export function adminPageI18nSource(): string {
  return `let adminLocale = 'zh-CN';\nconst ADMIN_MESSAGES = ${serializeAdminData(ADMIN_MESSAGES)};\n` + [normalizeAdminLocale, translate, translateAdminText, formatAdminDate, formatAdminNumber, formatAdminDurationUnit, formatAdminDuration, renderAdminMarkupText, localizeAdminMarkup].map((fn) => fn.toString()).join('\n');
}
