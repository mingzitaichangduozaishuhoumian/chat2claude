import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// Never follow a junction/symlink when writing an installation or its secrets.
export function assertNoSymlinks(target) {
  let current = path.resolve(target);
  for (;;) {
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) {
      throw new Error('Gateway paths must not contain symbolic links or junctions.');
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function gatewayPaths({ root = projectRoot, directory } = {}) {
  const base = path.resolve(root, directory || 'apps/api/data/web-gateway');
  if (base === path.parse(base).root || base === path.resolve(root)) {
    throw new Error('Choose a dedicated gateway directory, not a filesystem or project root.');
  }
  const result = {
    directory: base,
    source: path.join(base, 'source'),
    settings: path.join(base, 'settings.json'),
    state: path.join(base, 'install-state.json'),
    session: path.join(base, 'source/auth/session.json'),
  };
  for (const value of Object.values(result)) assertNoSymlinks(value);
  return result;
}

export function readMetadata(root = projectRoot) {
  const base = path.join(root, 'integrations/gpt-web-gateway');
  const metadata = JSON.parse(fs.readFileSync(path.join(base, 'upstream.json'), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(metadata.commit) || typeof metadata.repository !== 'string' || !metadata.repository) {
    throw new Error('Invalid pinned gateway metadata.');
  }
  const patchPath = path.resolve(base, metadata.patch || 'chat-vision.patch');
  if (path.dirname(patchPath) !== base) throw new Error('Gateway patch must be inside its integration directory.');
  return { ...metadata, patchPath };
}

export function createSettings({ port = 3101 } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid gateway port.');
  return { version: 1, host: '127.0.0.1', port, apiKey: `c2c-web-${randomBytes(32).toString('hex')}` };
}

export function validateSettings(value) {
  if (value?.version !== 1 || value.host !== '127.0.0.1' || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !/^c2c-web-[a-f0-9]{64}$/.test(value.apiKey)) {
    throw new Error('Invalid private gateway settings; preserve the file and choose a new directory.');
  }
  return value;
}

function readJson(file, description) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`Cannot read ${description}; preserve the directory and choose a new one.`); }
}

function writePrivateJson(file, value) {
  assertNoSymlinks(file);
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

// Capture subprocess output: dependency/git failures must not echo inherited secrets.
export function runCommand(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error(`${options.label || path.basename(command)} failed; installation files were preserved.`);
  }
}

function npmCommand() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    '/usr/share/nodejs/npm/bin/npm-cli.js',
  ];
  const cli = candidates.find((value) => value && path.basename(value) === 'npm-cli.js' && fs.existsSync(value));
  if (cli) return [process.execPath, [cli]];
  if (process.platform !== 'win32') return ['npm', []];
  throw new Error('Cannot find npm-cli.js beside Node.js. Install Node.js with npm, then rerun setup.');
}

function dependencyFiles(source) {
  return ['patchright', 'express', 'dotenv', 'multer', 'uuid'].map((name) => path.join(source, 'node_modules', name, 'package.json'));
}

export function dependenciesReady(source) {
  return dependencyFiles(source).every((file) => fs.existsSync(file));
}

function sourceFingerprint(paths, run) {
  const output = (args) => run('git', ['-C', paths.source, ...args], { label: 'Gateway source validation' });
  return {
    commit: output(['rev-parse', 'HEAD']).trim(),
    diff: sha256(output(['diff', '--binary', '--no-ext-diff', '--no-renames', 'HEAD'])),
    untracked: output(['ls-files', '--others', '--exclude-standard']).trim(),
  };
}

function expectedInstallation(metadata) {
  return { version: 1, repository: metadata.repository, commit: metadata.commit, patchSha256: sha256(fs.readFileSync(metadata.patchPath)) };
}

export function validateInstallation(paths, metadata, run = runCommand) {
  if (!fs.existsSync(paths.state) || !fs.existsSync(paths.source)) {
    throw new Error('Gateway is not installed. Run the web-gateway setup command first.');
  }
  const state = readJson(paths.state, 'gateway installation state');
  const expected = expectedInstallation(metadata);
  if (Object.entries(expected).some(([key, value]) => state[key] !== value)) {
    throw new Error('Gateway version or patch changed. Preserve this installation and run setup with a new --directory.');
  }
  const source = sourceFingerprint(paths, run);
  if (source.commit !== metadata.commit || source.diff !== state.sourceDiffSha256 || source.untracked) {
    throw new Error('Gateway source has unexpected changes. Preserve this installation and use a new --directory.');
  }
  return state;
}

export function setupGateway({ root = projectRoot, directory, metadata = readMetadata(root), run = runCommand, install = true } = {}) {
  const paths = gatewayPaths({ root, directory });
  const expected = expectedInstallation(metadata);
  let state;
  if (fs.existsSync(paths.source) || fs.existsSync(paths.state)) {
    state = validateInstallation(paths, metadata, run);
  } else {
    // An unknown/partial directory is never reset or recursively removed.
    if (fs.existsSync(paths.directory) && fs.readdirSync(paths.directory).length) {
      throw new Error('Gateway directory is not an empty managed installation. Preserve it and choose a new --directory.');
    }
    fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    run('git', ['clone', '--config', 'core.autocrlf=false', '--no-checkout', '--', metadata.repository, paths.source], { label: 'Pinned gateway clone' });
    run('git', ['-C', paths.source, 'checkout', '--detach', metadata.commit], { label: 'Pinned gateway checkout' });
    run('git', ['-C', paths.source, 'apply', '--index', '--check', metadata.patchPath], { label: 'Gateway patch check' });
    run('git', ['-C', paths.source, 'apply', '--index', metadata.patchPath], { label: 'Gateway patch' });
    const source = sourceFingerprint(paths, run);
    if (source.commit !== metadata.commit || source.untracked) throw new Error('Pinned gateway source did not validate. Files were preserved.');
    state = { ...expected, sourceDiffSha256: source.diff, dependenciesInstalled: false };
    writePrivateJson(paths.state, state);
  }
  const settings = fs.existsSync(paths.settings)
    ? validateSettings(readJson(paths.settings, 'private gateway settings'))
    : createSettings({ port: metadata.port || 3101 });
  if (!fs.existsSync(paths.settings)) writePrivateJson(paths.settings, settings);
  if (install && (!state.dependenciesInstalled || !dependenciesReady(paths.source))) {
    const [command, prefix] = npmCommand();
    state = { ...state, dependenciesInstalled: false };
    writePrivateJson(paths.state, state);
    run(command, [...prefix, 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: paths.source,
      label: 'Gateway dependency installation',
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', PUPPETEER_SKIP_DOWNLOAD: 'true' },
    });
    if (!dependenciesReady(paths.source)) throw new Error('Gateway dependencies are incomplete. Rerun setup.');
    state = { ...state, dependenciesInstalled: true };
    writePrivateJson(paths.state, state);
  }
  return { paths, settings, dependenciesReady: !!state.dependenciesInstalled && dependenciesReady(paths.source) };
}

export function gatewayEnvironment(settings, inherited = process.env) {
  validateSettings(settings);
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (/^CHATGPT_(EMAIL|PASSWORD|TOTP)/i.test(key)) delete env[key];
  }
  // Explicit empty values also prevent an upstream .env file from enabling auto-login.
  return {
    ...env,
    CHATGPT_EMAIL: '', CHATGPT_PASSWORD: '', CHATGPT_TOTP_SECRET: '', CHATGPT_TOTP: '',
    HOST: '127.0.0.1', PORT: String(settings.port), API_KEY: settings.apiKey,
    HEADLESS: 'false', BROWSER_ENGINE: 'patchright', CHROMIUM_CHANNEL: 'chrome',
    BROWSER_MODE: 'default', ORDINARY_CHAT_ONLY: 'true', MAX_CONCURRENT_JOBS: '1', DEBUG_SNAPSHOTS: '0', STALL_SNAPSHOTS: '0',
  };
}

export function gatewayStatus({ root = projectRoot, directory, metadata = readMetadata(root) } = {}) {
  const paths = gatewayPaths({ root, directory });
  let installed = false;
  let dependencyInstallationComplete = false;
  if (fs.existsSync(paths.state) && fs.existsSync(paths.source)) {
    dependencyInstallationComplete = validateInstallation(paths, metadata).dependenciesInstalled === true;
    installed = true;
  }
  const settings = fs.existsSync(paths.settings) ? validateSettings(readJson(paths.settings, 'private gateway settings')) : null;
  return {
    installed,
    dependenciesReady: installed && dependencyInstallationComplete && dependenciesReady(paths.source),
    host: '127.0.0.1',
    port: settings?.port || metadata.port || 3101,
    sessionFileExists: fs.existsSync(paths.session),
  };
}

export function localApiOrigin(apiUrl) {
  let url;
  try { url = new URL(apiUrl); } catch { throw new Error('The API URL must be a local loopback origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The API URL must be a local loopback origin.');
  }
  return url.origin;
}

export async function connectGateway({ settings, apiUrl, fetchImpl = fetch }) {
  validateSettings(settings);
  const origin = localApiOrigin(apiUrl);
  try {
    const bootstrap = await fetchImpl(`${origin}/admin`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!bootstrap.ok) throw new Error('Bootstrap failed.');
    const setCookies = bootstrap.headers.getSetCookie?.() || [bootstrap.headers.get('set-cookie') || ''];
    const cookies = setCookies.map((value) => value.split(';', 1)[0].trim()).filter((value) => /^[!#$%&'*+\-.^_`|~\dA-Za-z]+=[^\s;,\r\n]+$/.test(value));
    if (!cookies.length) throw new Error('Missing local admin session.');
    const response = await fetchImpl(`${origin}/admin/api/backend-routing`, {
      method: 'PATCH', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', origin, cookie: cookies.join('; ') },
      body: JSON.stringify({
        webEnabled: true, mode: 'web', autoPreference: 'web',
        gateway: { baseUrl: `http://127.0.0.1:${settings.port}`, apiKey: settings.apiKey, models: ['auto'], supportsTools: false, supportsImages: true, modelMappings: { sonnet: 'auto' } },
      }),
    });
    if (!response.ok) throw new Error('Configuration failed.');
  } catch {
    throw new Error('Could not connect to the local admin API. Start the main app and check local admin access.');
  }
}

async function checkPort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error('Gateway port is already in use or unavailable. Stop the existing gateway first.')));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

export async function runForeground(args, options, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: false });
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      // Windows child.kill('SIGINT') forcibly terminates Node without its cleanup.
      // The owned child closes its browser on this IPC message, then exits itself.
      if (child.connected) child.send({ type: 'chat2claude:shutdown' }, () => {});
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const cleanup = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      signal?.removeEventListener('abort', stop);
    };
    child.once('error', () => { cleanup(); reject(new Error('Gateway process could not start.')); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
}

export async function main(args = process.argv.slice(2)) {
  args = args.filter((arg) => arg !== '--');
  const command = args.shift();
  let directory;
  let apiUrl;
  const usage = 'Usage: node scripts/web-gateway.mjs setup|login|start|status|connect [--directory PATH] [--api-url LOOPBACK_ORIGIN (connect only)]';
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(usage);
    if (flag === '--directory' && directory === undefined) directory = value;
    else if (flag === '--api-url' && apiUrl === undefined && command === 'connect') apiUrl = value;
    else throw new Error(usage);
  }
  if (!['setup', 'login', 'start', 'status', 'connect'].includes(command) || (command === 'connect' && !apiUrl)) throw new Error(usage);
  if (command === 'status') { console.log(JSON.stringify(gatewayStatus({ directory }), null, 2)); return 0; }
  if (command === 'setup') {
    const result = setupGateway({ directory });
    console.log(`Gateway installed at ${result.paths.directory}`);
    console.log(`Local endpoint: http://127.0.0.1:${result.settings.port}/v1`);
    console.log('Private API key is stored in settings.json; it is never printed. Run web-gateway login next.');
    return 0;
  }
  const paths = gatewayPaths({ directory });
  const state = validateInstallation(paths, readMetadata());
  if (!state.dependenciesInstalled || !dependenciesReady(paths.source)) throw new Error('Gateway dependencies are incomplete. Run setup first.');
  const settings = validateSettings(readJson(paths.settings, 'private gateway settings'));
  if (command === 'connect') {
    await connectGateway({ settings, apiUrl });
    console.log('Local ChatGPT web gateway connected. Web usage is enabled and selected in manual mode.');
    return 0;
  }
  if (command === 'start') {
    if (!fs.existsSync(paths.session)) throw new Error('No saved ChatGPT login. Run web-gateway login first.');
    await checkPort(settings.port);
  }
  const childArgs = command === 'login'
    ? [fileURLToPath(new URL('./web-gateway-login.cjs', import.meta.url)), paths.source]
    : [path.join(paths.source, 'src/server.js')];
  return runForeground(childArgs, { cwd: paths.source, env: gatewayEnvironment(settings) });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    // Only our bounded error messages are exposed, never subprocess/browser diagnostics.
    const message = error instanceof SyntaxError ? 'Invalid gateway metadata or state.' : error.message;
    console.error(`[web-gateway] ${message}`);
    process.exitCode = 1;
  });
}
