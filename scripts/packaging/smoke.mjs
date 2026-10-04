import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { checkDistribution, cleanupTemp, json, root, sha256, tempDirectory, within } from './common.mjs';
import { extractTar, extractZip } from './archives.mjs';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
let directory = path.join(root, 'dist-release');
if (args.length) {
  if (args.length !== 2 || args[0] !== '--dir') throw new Error('Usage: package:smoke [--dir release-directory]');
  directory = path.resolve(args[1]);
}
const manifest = json(path.join(directory, 'release-manifest.json'));
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.match(manifest.source.commit, /^[a-f0-9]{40}$/);
assert.equal(typeof manifest.source.dirty, 'boolean');
const prefix = `chat2claude-v${manifest.version}`;
const expected = [`${prefix}-node.zip`, `${prefix}-node.tar.gz`, `${prefix}-windows-x64.zip`];
assert.deepEqual(manifest.artifacts.map((item) => item.file).sort(), [...expected].sort());
const sums = new Map();
for (const line of fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/)) {
  const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(line);
  assert(match && [...expected, 'release-manifest.json'].includes(match[2]), 'Unexpected checksum entry');
  assert(!sums.has(match[2]), 'Duplicate checksum entry');
  sums.set(match[2], match[1]);
}
assert.equal(sums.size, 4);
for (const [name, sum] of sums) assert.equal(await sha256(path.join(directory, name)), sum, `Checksum mismatch: ${name}`);
for (const artifact of manifest.artifacts) {
  assert.equal(artifact.target, artifact.file.endsWith('-windows-x64.zip') ? 'windows-x64' : 'node');
  assert.equal(artifact.sha256, sums.get(artifact.file));
  assert.equal(artifact.bytes, fs.statSync(path.join(directory, artifact.file)).size);
}

function browserPath() {
  if (process.env.PACKAGE_SMOKE_BROWSER_PATH) return path.resolve(process.env.PACKAGE_SMOKE_BROWSER_PATH);
  const candidates = process.platform === 'win32' ? [
    path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  ] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error('Chrome/Edge is required for package smoke; set PACKAGE_SMOKE_BROWSER_PATH.');
  return found;
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.notEqual(port, 3100);
  return port;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (await predicate()) return; await delay(100); }
  throw new Error('Packaged service did not become ready.');
}
async function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  for (let index = 0; index < 50; index++) { if (child.exitCode !== null || child.signalCode !== null) return; await delay(100); }
  child.kill('SIGKILL');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5_000);
}
function isolatedEnvironment(port, apiKey) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:CHATGPT_|CODEX_|DEFAULT_|MOCK_|STATE_|MODEL_REGISTRY_JSON$|DATA_DIR$|HOST$|PORT$|NODE_OPTIONS$|NODE_PATH$|OUTBOUND_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)|TOKEN|SECRET|PASSWORD|COOKIE|API_KEY/i.test(key)) delete env[key];
  return { ...env, HOST: '127.0.0.1', PORT: String(port), API_KEYS: apiKey, LOG_LEVEL: 'error' };
}
async function exercise(pack, runtime) {
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const apiKey = `package-smoke-${randomUUID()}`;
  // Prove dotenv loading and external-env precedence without inheriting account data.
  fs.writeFileSync(path.join(pack, '.env'), 'CHATGPT_BACKEND=mock\nHOST=192.0.2.1\nPORT=1\nAPI_KEYS=dotenv-must-not-win\nMOCK_BACKEND_MODELS_JSON=\'["packaging-smoke-model"]\'\n');
  let output = '';
  let spawnError;
  const child = spawn(runtime, [path.join(pack, 'start.mjs')], { cwd: pack, env: isolatedEnvironment(port, apiKey), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', (error) => { spawnError = error; });
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-16_384); });
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-16_384); });
  let browser;
  try {
    await waitFor(async () => {
      if (spawnError || child.exitCode !== null) throw new Error(`Packaged service exited: ${spawnError?.message ?? output}`);
      if (!output.includes(`:${port}`)) return false;
      try { return (await fetch(origin + '/healthz')).ok; } catch { return false; }
    });
    assert.equal((await (await fetch(origin + '/healthz')).json()).ok, true);
    assert.equal((await fetch(origin + '/v1/models')).status, 401);
    const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
    const models = await (await fetch(origin + '/v1/models', { headers })).json();
    assert(models.data.some((model) => model.id === 'packaging-smoke-model'));
    const admin = await (await fetch(origin + '/admin/api/models', { headers })).json();
    assert.deepEqual(admin.aliases.map((model) => model.id).sort(), json(path.join(pack, 'config/models.json')).aliases.map((model) => model.id).sort());
    for (const [endpoint, body] of [
      ['/v1/messages', { max_tokens: 32, messages: [{ role: 'user', content: 'packaging-smoke-text' }] }],
      ['/v1/chat/completions', { messages: [{ role: 'user', content: 'packaging-smoke-text' }] }],
      ['/v1/responses', { input: 'packaging-smoke-text', store: false }],
    ]) {
      const response = await fetch(origin + endpoint, { method: 'POST', headers, body: JSON.stringify({ model: 'packaging-smoke-model', ...body }) });
      assert.equal(response.status, 200, endpoint);
      assert.match(await response.text(), /packaging-smoke-text/);
    }
    const streaming = await fetch(origin + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'packaging-smoke-model', max_tokens: 32, messages: [{ role: 'user', content: 'stream-smoke' }], stream: true }) });
    assert.equal(streaming.status, 200);
    assert.match(await streaming.text(), /event: message_stop/);
    const errors = [];
    const unexpected = [];
    browser = await chromium.launch({ executablePath: browserPath(), headless: true });
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || url.pathname === '/v1/images/generations' || url.pathname.startsWith('/admin/api/auth/chatgpt/')) {
        unexpected.push(url.pathname); return route.abort();
      }
      return route.continue();
    });
    await page.goto(origin + '/admin', { waitUntil: 'networkidle' });
    await page.locator('#models-tab').click();
    await page.waitForFunction(() => document.body.textContent.includes('packaging-smoke-model'));
    await page.locator('#locale-en').click();
    await page.waitForFunction(() => document.getElementById('locale-en').getAttribute('aria-pressed') === 'true');
    await page.locator('#mode-professional').click();
    await page.waitForFunction(() => document.getElementById('mode-professional').getAttribute('aria-pressed') === 'true');
    const uiModels = await page.evaluate(async () => (await fetch('/admin/api/models')).json());
    assert.equal(uiModels.discovered[0].id, 'packaging-smoke-model');
    assert.deepEqual(errors, [], 'Admin browser JavaScript failed');
    assert.deepEqual(unexpected, [], 'Smoke attempted an external/OAuth/image request');
    assert(fs.existsSync(path.join(pack, 'data')), 'Launcher did not create package-local data');
    return { health: true, authentication: true, defaultAliases: admin.aliases.length, textProtocols: 3, textStream: true, adminBrowser: true, adminLocales: 2, imageRequests: 0 };
  } finally {
    try { await browser?.close(); }
    finally { await stop(child); }
  }
}

const owned = tempDirectory('smoke with spaces');
try {
  const results = [];
  for (const artifact of manifest.artifacts) {
    const pack = path.join(owned.directory, artifact.file + ' extracted with spaces');
    if (artifact.file.endsWith('.zip')) await extractZip(path.join(directory, artifact.file), pack);
    else await extractTar(path.join(directory, artifact.file), pack);
    checkDistribution(pack);
    const inside = json(path.join(pack, 'release-manifest.json'));
    assert.equal(inside.version, manifest.version);
    assert.deepEqual(inside.source, manifest.source);
    assert.equal(inside.target, artifact.target);
    assert.equal(inside.runtime.bundled, artifact.target === 'windows-x64');
    assert.deepEqual(inside.dependencies, manifest.dependencies);
    assert.equal(json(path.join(pack, 'app/package.json')).version, manifest.version);
    assert(!fs.existsSync(path.join(pack, 'app/node_modules/.pnpm')), 'Deployment still needs a pnpm virtual store');
    for (const dependency of inside.dependencies) for (const license of dependency.licenseFiles) {
      assert(within(pack, path.join(pack, license)) && fs.statSync(path.join(pack, license)).isFile());
    }
    if (inside.runtime.bundled) {
      assert.equal(inside.runtime.version, '24.21.0');
      assert.equal(await sha256(path.join(pack, 'runtime/node.exe')), inside.runtime.executableSha256);
      assert(fs.existsSync(path.join(pack, inside.runtime.licenseFile)));
    }
    if (inside.runtime.bundled && process.platform !== 'win32') {
      results.push({ artifact: artifact.file, structure: true, runtimeExecuted: false, note: 'Windows runtime requires the Windows smoke job.' });
      continue;
    }
    const runtime = inside.runtime.bundled ? path.join(pack, 'runtime/node.exe') : process.execPath;
    const runtimeVersion = execFileSync(runtime, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
    if (inside.runtime.bundled) assert.equal(runtimeVersion, `v${inside.runtime.version}`);
    results.push({ artifact: artifact.file, node: runtimeVersion, runtimeExecuted: true, ...await exercise(pack, runtime) });
  }
  console.log(JSON.stringify({ version: manifest.version, dirty: manifest.source.dirty, results }, null, 2));
} finally { cleanupTemp(owned); }
