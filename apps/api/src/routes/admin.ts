import { Hono } from 'hono';
import type { ReasoningEffort, SpeedPreference } from '@chatgpt-to-claude/protocol-mapper';
import type { AccountPool } from '../services/account-pool.js';
import type { ModelRegistry } from '../services/model-registry.js';
import type { RuntimeApiKeys } from '../services/runtime-api-keys.js';

const DEV_API_KEY = 'sk-test';

export interface AdminRouteOptions {
  accountPool: AccountPool;
  modelRegistry: ModelRegistry;
  runtimeApiKeys: RuntimeApiKeys;
  envApiKeys: string[];
  defaultReasoningEffort: ReasoningEffort;
  defaultResponseSpeed: SpeedPreference;
}

export function createAdminRoute(options: AdminRouteOptions): Hono {
  const app = new Hono();
  app.get('/admin', (c) => c.html(renderAdminPage(status(options))));
  app.get('/admin/accounts', (c) => c.json({ accounts: options.accountPool.list() }));
  app.get('/admin/api/setup/status', (c) => c.json(status(options)));
  app.post('/admin/api/api-keys/dev-enable', (c) => {
    options.runtimeApiKeys.add(DEV_API_KEY);
    return c.json({
      ok: true,
      message: 'Development API key enabled in memory. Use x-api-key: sk-test for /v1/* until the process restarts.',
      key: DEV_API_KEY,
      status: status(options),
    });
  });

  app.get('/admin/api/accounts', (c) => c.json({ accounts: options.accountPool.list() }));
  app.post('/admin/api/accounts', async (c) => {
    try {
      const account = options.accountPool.add(await readJson(c.req));
      return c.json({ account }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid account' }, 400);
    }
  });
  app.patch('/admin/api/accounts/:id', async (c) => {
    const account = options.accountPool.update(c.req.param('id'), await readJson(c.req));
    return account ? c.json({ account }) : c.json({ error: 'Account not found' }, 404);
  });
  app.post('/admin/api/accounts/:id/health-check', (c) => {
    const account = options.accountPool.healthCheck(c.req.param('id'));
    return account ? c.json({ ok: true, account }) : c.json({ error: 'Account not found' }, 404);
  });

  app.get('/admin/api/models', (c) => c.json({ models: options.modelRegistry.list() }));
  app.patch('/admin/api/models/:id', async (c) => {
    const model = options.modelRegistry.update(c.req.param('id'), await readJson(c.req));
    return model ? c.json({ model }) : c.json({ error: 'Model not found' }, 404);
  });
  app.post('/admin/api/models/reset', (c) => c.json({ models: options.modelRegistry.reset() }));
  return app;
}

async function readJson(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function status(options: AdminRouteOptions) {
  const envApiKeysConfigured = options.envApiKeys.length > 0;
  const runtimeApiKeysConfigured = options.runtimeApiKeys.size > 0;
  return {
    apiKeysConfigured: envApiKeysConfigured || runtimeApiKeysConfigured,
    envApiKeysConfigured,
    runtimeApiKeysConfigured,
    runtimeApiKeysCount: options.runtimeApiKeys.size,
    defaultReasoningEffort: options.defaultReasoningEffort,
    defaultResponseSpeed: options.defaultResponseSpeed,
    mockBackend: { enabled: true, provider: 'mock', chatGptConnected: false },
    defaultEndpoint: 'POST /v1/messages',
    nextStep: envApiKeysConfigured || runtimeApiKeysConfigured
      ? 'Call /v1/messages with x-api-key or Authorization: Bearer token. ChatGPT authorization is still a placeholder.'
      : 'Open /admin and click Enable development API key, then call /v1/messages with x-api-key: sk-test.',
  };
}

function renderAdminPage(setupStatus: ReturnType<typeof status>): string {
  const keyState = setupStatus.apiKeysConfigured ? 'Configured' : 'Not configured';
  const curlExample = `curl http://localhost:3000/v1/messages \\
  -H 'content-type: application/json' \\
  -H 'x-api-key: sk-test' \\
  -d '{"model":"sonnet","max_tokens":128,"reasoning_effort":"medium","response_speed":"balanced","messages":[{"role":"user","content":"你好"}]}'`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>chatgpt-to-claude Admin</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f6f8fb; }
    main { max-width: 1040px; margin: 40px auto; padding: 0 20px 48px; }
    .card { background: #fff; border: 1px solid #dfe6f0; border-radius: 14px; padding: 22px; margin: 18px 0; box-shadow: 0 10px 30px rgba(23,32,51,0.06); }
    h1 { margin: 0 0 8px; font-size: 30px; }
    h2 { margin: 0 0 14px; font-size: 20px; }
    code, pre { background: #eef3f8; border-radius: 8px; padding: 2px 6px; }
    pre { padding: 14px; overflow: auto; white-space: pre-wrap; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border-bottom: 1px solid #e6edf5; padding: 10px 8px; text-align: left; vertical-align: top; }
    input, select { border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px 10px; }
    .status { display: inline-block; padding: 4px 10px; border-radius: 999px; background: ${setupStatus.apiKeysConfigured ? '#e7f7ee' : '#fff4dd'}; color: ${setupStatus.apiKeysConfigured ? '#17633a' : '#8a5700'}; font-weight: 700; }
    button { border: 0; border-radius: 10px; padding: 9px 12px; background: #1f6feb; color: #fff; font-weight: 700; cursor: pointer; }
    button.secondary { background: #64748b; }
    button.placeholder { background: #94a3b8; cursor: not-allowed; }
    .muted { color: #5c6b82; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  </style>
</head>
<body>
  <main>
    <h1>chatgpt-to-claude Admin</h1>
    <p class="muted">当前是 mock 阶段：提供 runtime 管理后台骨架，不接真实 ChatGPT。</p>

    <section class="card">
      <h2>授权状态</h2>
      <p>API key 配置状态：<span id="key-state" class="status">${escapeHtml(keyState)}</span></p>
      <ul>
        <li>默认 endpoint：<code>${escapeHtml(setupStatus.defaultEndpoint)}</code></li>
        <li>全局 fallback reasoning effort：<code>${escapeHtml(setupStatus.defaultReasoningEffort)}</code></li>
        <li>全局 fallback response speed：<code>${escapeHtml(setupStatus.defaultResponseSpeed)}</code></li>
        <li>Mock backend：<code>enabled</code>，ChatGPT connected：<code>false</code></li>
      </ul>
      <button id="dev-enable">Enable development API key</button>
      <pre id="result">${escapeHtml(setupStatus.nextStep)}</pre>
    </section>

    <section class="card">
      <h2>账号池</h2>
      <div class="row">
        <input id="account-label" placeholder="Mock account label" value="Mock ChatGPT Account" />
        <input id="account-concurrency" type="number" min="1" value="1" />
        <button id="add-account">添加 mock 账号</button>
      </div>
      <div id="accounts"></div>
    </section>

    <section class="card">
      <h2>模型映射</h2>
      <p class="muted">修改后立即影响 mock /v1/messages 缺省 reasoning_effort/response_speed。</p>
      <div class="row"><button id="reset-models" class="secondary">重置模型映射</button></div>
      <div id="models"></div>
    </section>

    <section class="card">
      <h2>curl 示例</h2>
      <pre>${escapeHtml(curlExample)}</pre>
    </section>

    <section class="card">
      <h2>ChatGPT 授权占位</h2>
      <p class="muted">后续真实账号登录、cookie/session 授权与健康检查会接到这里；当前按钮不会连接真实 ChatGPT。</p>
      <button class="placeholder" disabled>Connect ChatGPT (placeholder)</button>
    </section>
  </main>
  <script>
    const effortOptions = ['off', 'minimal', 'low', 'medium', 'high', 'max'];
    const speedOptions = ['fastest', 'fast', 'balanced', 'quality'];

    document.getElementById('dev-enable').addEventListener('click', async () => {
      const body = await postJson('/admin/api/api-keys/dev-enable');
      document.getElementById('key-state').textContent = body.status.apiKeysConfigured ? 'Configured' : 'Not configured';
      document.getElementById('result').textContent = JSON.stringify(body, null, 2);
    });

    document.getElementById('add-account').addEventListener('click', async () => {
      const label = document.getElementById('account-label').value;
      const maxConcurrency = Number(document.getElementById('account-concurrency').value || 1);
      await postJson('/admin/api/accounts', { label, maxConcurrency, capabilities: ['mock', 'messages'] });
      await loadAccounts();
    });

    document.getElementById('reset-models').addEventListener('click', async () => {
      await postJson('/admin/api/models/reset');
      await loadModels();
    });

    async function loadAccounts() {
      const body = await getJson('/admin/api/accounts');
      document.getElementById('accounts').innerHTML = '<table><thead><tr><th>ID</th><th>Label</th><th>Status</th><th>Concurrency</th><th>Last Used</th><th>Capabilities</th><th>Action</th></tr></thead><tbody>' + body.accounts.map((account) =>
        '<tr><td><code>' + esc(account.id) + '</code></td><td>' + esc(account.label) + '</td><td>' + esc(account.status) + (account.enabled ? '' : ' / disabled') + '</td><td>' + account.currentConcurrency + '/' + account.maxConcurrency + '</td><td>' + esc(account.lastUsedAt || '-') + '</td><td>' + esc(account.capabilities.join(', ')) + '</td><td><button data-health="' + esc(account.id) + '">health-check</button></td></tr>'
      ).join('') + '</tbody></table>';
      document.querySelectorAll('[data-health]').forEach((button) => button.addEventListener('click', async () => {
        await postJson('/admin/api/accounts/' + encodeURIComponent(button.dataset.health) + '/health-check');
        await loadAccounts();
      }));
    }

    async function loadModels() {
      const body = await getJson('/admin/api/models');
      document.getElementById('models').innerHTML = '<table><thead><tr><th>Alias</th><th>Claude Model</th><th>Backend Model</th><th>Enabled</th><th>Defaults</th><th>Action</th></tr></thead><tbody>' + body.models.map((model) =>
        '<tr><td><code>' + esc(model.id) + '</code></td><td><input data-field="claudeModel" data-id="' + esc(model.id) + '" value="' + esc(model.claudeModel) + '" /></td><td><input data-field="backendModel" data-id="' + esc(model.id) + '" value="' + esc(model.backendModel) + '" /></td><td><input type="checkbox" data-field="enabled" data-id="' + esc(model.id) + '" ' + (model.enabled ? 'checked' : '') + ' /></td><td>' + selectHtml(model.id, 'reasoning_effort', effortOptions, model.defaults.reasoning_effort) + ' ' + selectHtml(model.id, 'speed', speedOptions, model.defaults.speed) + '</td><td><button data-save-model="' + esc(model.id) + '">保存</button></td></tr>'
      ).join('') + '</tbody></table>';
      document.querySelectorAll('[data-save-model]').forEach((button) => button.addEventListener('click', async () => saveModel(button.dataset.saveModel)));
    }

    async function saveModel(id) {
      const byField = (field) => document.querySelector('[data-id="' + CSS.escape(id) + '"][data-field="' + field + '"]');
      await patchJson('/admin/api/models/' + encodeURIComponent(id), {
        claudeModel: byField('claudeModel').value,
        backendModel: byField('backendModel').value,
        enabled: byField('enabled').checked,
        defaults: { reasoning_effort: byField('reasoning_effort').value, speed: byField('speed').value },
      });
      await loadModels();
    }

    function selectHtml(id, field, options, current) {
      return '<select data-field="' + field + '" data-id="' + esc(id) + '">' + options.map((option) => '<option value="' + option + '" ' + (option === current ? 'selected' : '') + '>' + option + '</option>').join('') + '</select>';
    }
    async function getJson(url) { return (await fetch(url)).json(); }
    async function postJson(url, body) { return (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json(); }
    async function patchJson(url, body) { return (await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); }
    function esc(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
    loadAccounts();
    loadModels();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
