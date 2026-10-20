import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertNoSymlinks, connectGateway, createSettings, gatewayEnvironment, gatewayPaths, localApiOrigin,
  gatewayStatus, readMetadata, runCommand, runForeground, setupGateway, validateInstallation, validateSettings,
} from './web-gateway.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2claude-gateway-test-'));
  t.after(() => {
    const real = fs.realpathSync(directory);
    assert.equal(path.dirname(real).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert(path.basename(real).startsWith('chat2claude-gateway-test-'));
    fs.rmSync(real, { recursive: true, force: true });
  });
  const upstream = path.join(directory, 'upstream');
  fs.mkdirSync(upstream);
  const git = (args) => execFileSync('git', args, { cwd: upstream, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']);
  git(['config', 'user.name', 'Gateway Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(upstream, '.gitignore'), 'node_modules/\nauth/\n');
  fs.writeFileSync(path.join(upstream, 'package.json'), '{"name":"offline-gateway-fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(upstream, 'package-lock.json'), '{"name":"offline-gateway-fixture","lockfileVersion":3}\n');
  fs.writeFileSync(path.join(upstream, 'gateway.txt'), 'before\n');
  git(['add', '.']);
  git(['commit', '-m', 'Fixture']);
  const commit = git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(upstream, 'gateway.txt'), 'after\n');
  fs.writeFileSync(path.join(upstream, 'vision.txt'), 'new patched file\n');
  git(['add', '--intent-to-add', 'vision.txt']);
  const patch = git(['diff', '--binary']);
  git(['reset', '--', 'vision.txt']);
  fs.unlinkSync(path.join(upstream, 'vision.txt'));
  git(['checkout', '--', 'gateway.txt']);
  const integration = path.join(directory, 'integrations/gpt-web-gateway');
  fs.mkdirSync(integration, { recursive: true });
  const patchPath = path.join(integration, 'chat-vision.patch');
  fs.writeFileSync(patchPath, patch);
  const metadata = { repository: upstream, commit, patch: 'chat-vision.patch', port: 3101, patchPath };
  fs.writeFileSync(path.join(integration, 'upstream.json'), JSON.stringify(metadata));
  const options = { root: directory, directory: path.join(directory, 'managed'), metadata, install: false };
  return { directory, upstream, metadata, options };
}

function fakeDependencies(source) {
  for (const name of ['patchright', 'express', 'dotenv', 'multer', 'uuid']) {
    const directory = path.join(source, 'node_modules', name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  }
}

test('settings use independent random keys, validate loopback, and reject malformed keys/ports', () => {
  const first = createSettings();
  const second = createSettings();
  assert.notEqual(first.apiKey, second.apiKey);
  assert.equal(validateSettings(first), first);
  assert.throws(() => validateSettings({ ...first, host: '0.0.0.0' }), /Invalid private gateway settings/);
  assert.throws(() => validateSettings({ ...first, apiKey: '' }), /Invalid private gateway settings/);
  assert.throws(() => createSettings({ port: 80 }), /Invalid gateway port/);
});

test('metadata accepts a fixed commit and refuses a patch outside its integration', (t) => {
  const { directory, metadata } = fixture(t);
  assert.equal(readMetadata(directory).commit, metadata.commit);
  fs.writeFileSync(path.join(directory, 'integrations/gpt-web-gateway/upstream.json'), JSON.stringify({ ...metadata, patch: '../escape.patch' }));
  assert.throws(() => readMetadata(directory), /inside its integration directory/);
});

test('offline setup clones exact commit, applies patch, and preserves key during reuse', (t) => {
  const { options, metadata } = fixture(t);
  const first = setupGateway(options);
  assert.equal(fs.readFileSync(path.join(first.paths.source, 'gateway.txt'), 'utf8'), 'after\n');
  assert.equal(fs.readFileSync(path.join(first.paths.source, 'vision.txt'), 'utf8'), 'new patched file\n');
  assert.equal(execFileSync('git', ['-C', first.paths.source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), metadata.commit);
  assert.equal(validateInstallation(first.paths, metadata).patchSha256.length, 64);
  const second = setupGateway(options);
  assert.equal(second.settings.apiKey, first.settings.apiKey);
  assert.equal(second.dependenciesReady, false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(first.paths.settings).mode & 0o777, 0o600);
});

test('setup refuses unknown source directories and leaves their files intact', (t) => {
  const { options } = fixture(t);
  const paths = gatewayPaths(options);
  fs.mkdirSync(paths.source, { recursive: true });
  const sentinel = path.join(paths.source, 'do-not-change.txt');
  fs.writeFileSync(sentinel, 'valuable local changes');
  assert.throws(() => setupGateway(options), /not installed/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'valuable local changes');
});

test('setup refuses a changed patch and leaves prior installation intact', (t) => {
  const { options, metadata } = fixture(t);
  const installation = setupGateway(options);
  fs.appendFileSync(metadata.patchPath, '\n');
  assert.throws(() => setupGateway(options), /patch changed/);
  assert.equal(fs.readFileSync(path.join(installation.paths.source, 'gateway.txt'), 'utf8'), 'after\n');
});

test('setup refuses tracked and untracked edits without resetting them', (t) => {
  const { options } = fixture(t);
  const installation = setupGateway(options);
  const tracked = path.join(installation.paths.source, 'gateway.txt');
  fs.writeFileSync(tracked, 'user changed this\n');
  assert.throws(() => setupGateway(options), /unexpected changes/);
  assert.equal(fs.readFileSync(tracked, 'utf8'), 'user changed this\n');
  fs.writeFileSync(tracked, 'after\n');
  const untracked = path.join(installation.paths.source, 'local.txt');
  fs.writeFileSync(untracked, 'keep me');
  assert.throws(() => setupGateway(options), /unexpected changes/);
  assert.equal(fs.readFileSync(untracked, 'utf8'), 'keep me');
});

test('existing stamp with missing dependencies still runs npm ci with lifecycle scripts disabled', (t) => {
  const { options } = fixture(t);
  const initial = setupGateway(options);
  const calls = [];
  const run = (command, args, commandOptions) => {
    if (args.includes('ci')) {
      calls.push({ command, args, options: commandOptions });
      fakeDependencies(initial.paths.source);
      return '';
    }
    return runCommand(command, args, commandOptions);
  };
  const installation = setupGateway({ ...options, install: true, run });
  assert.equal(installation.dependenciesReady, true);
  assert.equal(calls.length, 1);
  assert(calls[0].args.includes('--ignore-scripts'));
  assert(calls[0].args.includes('--omit=dev'));
  assert.equal(calls[0].options.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, '1');
  setupGateway({ ...options, install: true, run });
  assert.equal(calls.length, 1);
});

test('status reports session existence without reading its private contents or exposing key', (t) => {
  const { options, metadata } = fixture(t);
  const installation = setupGateway(options);
  fs.mkdirSync(path.dirname(installation.paths.session), { recursive: true });
  fs.writeFileSync(installation.paths.session, 'not JSON: private-cookie-secret');
  const result = gatewayStatus({ ...options, metadata });
  assert.equal(result.installed, true);
  assert.equal(result.sessionFileExists, true);
  assert(!JSON.stringify(result).includes(installation.settings.apiKey));
  assert(!JSON.stringify(result).includes('private-cookie-secret'));
});

test('a failed npm install is retried even when partial top-level dependencies exist', (t) => {
  const { options } = fixture(t);
  const installation = setupGateway(options);
  let attempts = 0;
  const run = (command, args, commandOptions) => {
    if (args.includes('ci')) {
      attempts++;
      fakeDependencies(installation.paths.source);
      if (attempts === 1) throw new Error('Fixture interrupted npm');
      return '';
    }
    return runCommand(command, args, commandOptions);
  };
  assert.throws(() => setupGateway({ ...options, install: true, run }), /Fixture interrupted npm/);
  assert.equal(JSON.parse(fs.readFileSync(installation.paths.state, 'utf8')).dependenciesInstalled, false);
  assert.equal(setupGateway({ ...options, install: true, run }).dependenciesReady, true);
  assert.equal(attempts, 2);
});

test('runtime is loopback, isolated headed Chrome, and cannot inherit auto-login credentials', () => {
  const settings = createSettings();
  const env = gatewayEnvironment(settings, {
    PATH: 'keep-path', HOST: '0.0.0.0', BROWSER_MODE: 'cdp', ORDINARY_CHAT_ONLY: 'false', HEADLESS: 'true',
    CHATGPT_EMAIL: 'private@example.invalid', CHATGPT_PASSWORD: 'private-password', CHATGPT_TOTP_SECRET: 'private-totp',
  });
  assert.equal(env.PATH, 'keep-path');
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.BROWSER_MODE, 'default');
  assert.equal(env.ORDINARY_CHAT_ONLY, 'true');
  assert.equal(env.BROWSER_ENGINE, 'patchright');
  assert.equal(env.CHROMIUM_CHANNEL, 'chrome');
  assert.equal(env.HEADLESS, 'false');
  assert.equal(env.MAX_CONCURRENT_JOBS, '1');
  assert.equal(env.SESSION_PROBE_TIMEOUT_SEC, '15');
  assert.equal(env.SESSION_LEASE_WAIT_MS, '60000');
  assert.equal(env.CHATGPT_EMAIL, '');
  assert.equal(env.CHATGPT_PASSWORD, '');
  assert.equal(env.CHATGPT_TOTP_SECRET, '');
  assert(!JSON.stringify(env).includes('private-'));
});

test('gateway installation refuses root paths and existing junctions', (t) => {
  const { directory } = fixture(t);
  assert.throws(() => gatewayPaths({ root: directory, directory }), /dedicated gateway directory/);
  assert.throws(() => gatewayPaths({ root: directory, directory: path.parse(directory).root }), /dedicated gateway directory/);
  const target = path.join(directory, 'target');
  const link = path.join(directory, 'link');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertNoSymlinks(path.join(link, 'settings.json')), /symbolic links or junctions/);
});

test('subprocess errors never expose captured diagnostics', () => {
  assert.throws(() => runCommand(process.execPath, ['-e', 'console.error("private-cookie-value");process.exit(1)'], { label: 'Fixture command' }), (error) => {
    assert(!error.message.includes('private-cookie-value'));
    assert.match(error.message, /Fixture command failed/);
    return true;
  });
});

test('connect only accepts loopback origins without credentials, paths, query, or fragment', () => {
  for (const url of ['http://127.0.0.1:3000', 'http://localhost:3000/', 'https://[::1]:3000']) assert.equal(localApiOrigin(url), new URL(url).origin);
  for (const url of ['https://external.invalid', 'http://user:password@localhost', 'http://localhost/admin', 'http://localhost/?key=secret', 'http://localhost/#secret', 'file:///etc/passwd']) assert.throws(() => localApiOrigin(url), /loopback origin/);
});

test('connect uses an in-memory local admin cookie and applies the explicit web configuration', async () => {
  const settings = createSettings();
  const calls = [];
  await connectGateway({ settings, apiUrl: 'http://127.0.0.1:3000/', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? { ok: true, headers: { getSetCookie: () => ['admin_session=private-cookie; HttpOnly; SameSite=Strict; Path=/'] } } : { ok: true };
  } });
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/admin');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[1].options.headers.cookie, 'admin_session=private-cookie');
  assert.equal(calls[1].options.headers.origin, 'http://127.0.0.1:3000');
  assert.equal(calls[1].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1].options.body), { webEnabled: true, mode: 'web', autoPreference: 'web', contextHandoff: true, gateway: { baseUrl: 'http://127.0.0.1:3101', apiKey: settings.apiKey, models: ['auto'], supportsTools: true, supportsStrictTools: false, supportsImages: true, modelMappings: { sonnet: 'auto' } } });
});

test('connect never follows redirects or exposes private server failures', async () => {
  for (const fetchImpl of [async () => { throw new Error('private-token-in-error'); }, async () => ({ ok: true, headers: { getSetCookie: () => [] } }), async (_url, options) => options.method === 'PATCH' ? { ok: false, text: () => { throw new Error('must not read body'); } } : { ok: true, headers: { getSetCookie: () => ['session=private-cookie'] } }]) {
    await assert.rejects(connectGateway({ settings: createSettings(), apiUrl: 'http://localhost:3000', fetchImpl }), (error) => {
      assert.match(error.message, /Could not connect to the local admin API/);
      assert(!error.message.includes('private-'));
      return true;
    });
  }
});

for (const cancellation of ['IPC cancellation', 'parent disconnect']) test(`${cancellation} closes the login helper owned browser and preserves an existing session`, async (t) => {
  const { upstream } = fixture(t);
  const browserMarker = path.join(upstream, 'owned-browser.txt');
  const session = path.join(upstream, 'auth/session.json');
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, 'existing private session');
  fs.mkdirSync(path.join(upstream, 'src'));
  fs.writeFileSync(path.join(upstream, 'src/browser-fingerprint.js'), 'exports.launchArgs=()=>[];');
  const dependency = path.join(upstream, 'node_modules/patchright');
  fs.mkdirSync(dependency, { recursive: true });
  // This fake driver creates an owned window resource, but never contacts ChatGPT.
  fs.writeFileSync(path.join(dependency, 'index.js'), `
    const fs = require('node:fs');
    const marker = ${JSON.stringify(browserMarker)};
    let closed = false;
    const page = { goto: async()=>{}, url:()=> 'https://chatgpt.com/', evaluate:async()=>false };
    const context = { newPage:async()=>page, pages:()=>[page], storageState:async()=>{throw new Error('must not save on cancel')} };
    exports.chromium = { launch:async()=>{
      fs.writeFileSync(marker, 'open');
      return { newContext:async()=>context, isConnected:()=>!closed, close:async()=>{closed=true;fs.writeFileSync(marker,'closed')} };
    }};
  `);
  const controller = new AbortController();
  const childArgs = [fileURLToPath(new URL('./web-gateway-login.cjs', import.meta.url)), upstream];
  const child = cancellation === 'parent disconnect' ? spawn(process.execPath, childArgs, { cwd: upstream, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true }) : null;
  const completion = child ? new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }) : runForeground(childArgs, { cwd: upstream }, { signal: controller.signal });
  t.after(() => { controller.abort(); if (child?.connected) child.disconnect(); });
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(browserMarker)) {
    assert(Date.now() < deadline, 'fake owned browser should open');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (child) child.disconnect();
  else controller.abort();
  assert.equal(await completion, 1);
  assert.equal(fs.readFileSync(browserMarker, 'utf8'), 'closed');
  assert.equal(fs.readFileSync(session, 'utf8'), 'existing private session');
});

for (const phase of ['launch', 'save']) test(`login cancelled during ${phase} closes its late browser and does not replace the session`, async (t) => {
  const { upstream } = fixture(t);
  const marker = path.join(upstream, 'phase.txt');
  const closed = path.join(upstream, 'closed.txt');
  const contextCreated = path.join(upstream, 'context-created.txt');
  const session = path.join(upstream, 'auth/session.json');
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, 'old private session');
  fs.mkdirSync(path.join(upstream, 'src'));
  fs.writeFileSync(path.join(upstream, 'src/browser-fingerprint.js'), 'exports.launchArgs=()=>[];');
  const dependency = path.join(upstream, 'node_modules/patchright');
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(path.join(dependency, 'index.js'), `
    const fs = require('node:fs');
    const phase = ${JSON.stringify(phase)};
    const pause = () => new Promise(resolve=>setTimeout(resolve,500));
    const page = { goto:async()=>{}, url:()=> 'https://chatgpt.com/', evaluate:async()=>true };
    const context = { newPage:async()=>page, pages:()=>[page], storageState:async()=>{
      fs.writeFileSync(${JSON.stringify(marker)},'save'); await pause(); return { cookies:[] };
    }};
    exports.chromium = { launch:async()=>{
      if(phase==='launch'){fs.writeFileSync(${JSON.stringify(marker)},'launch');await pause()}
      return {
        newContext:async()=>{fs.writeFileSync(${JSON.stringify(contextCreated)},'created');return context},
        isConnected:()=>true, close:async()=>{fs.writeFileSync(${JSON.stringify(closed)},'closed')},
      };
    }};
  `);
  const controller = new AbortController();
  const completion = runForeground([fileURLToPath(new URL('./web-gateway-login.cjs', import.meta.url)), upstream], { cwd: upstream }, { signal: controller.signal });
  t.after(() => controller.abort());
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(marker)) { assert(Date.now() < deadline); await new Promise(resolve=>setTimeout(resolve,20)); }
  controller.abort();
  assert.equal(await completion, 1);
  assert.equal(fs.readFileSync(closed, 'utf8'), 'closed');
  assert.equal(fs.readFileSync(session, 'utf8'), 'old private session');
  if (phase === 'launch') assert.equal(fs.existsSync(contextCreated), false);
});
