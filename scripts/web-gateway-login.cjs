// An isolated browser owned by this helper; never attaches to an existing profile.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomBytes } = require('node:crypto');

function assertPlainPath(target) {
  let current = path.resolve(target);
  for (;;) {
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw new Error('Unsafe login path.');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function login(source) {
  assertPlainPath(source);
  const requireGateway = createRequire(path.join(source, 'package.json'));
  const { chromium } = requireGateway('patchright');
  const fingerprint = requireGateway('./src/browser-fingerprint');
  const destination = path.join(source, 'auth/session.json');
  assertPlainPath(destination);
  let browser;
  let interrupted = false;
  const stop = () => { interrupted = true; void browser?.close().catch(() => {}); };
  const onMessage = (message) => { if (message?.type === 'chat2claude:shutdown') stop(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('message', onMessage);
  process.on('disconnect', stop);
  try {
    browser = await chromium.launch({ headless: false, channel: 'chrome', args: fingerprint.launchArgs('patchright') });
    if (interrupted) throw new Error('Login was cancelled.');
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    console.log('请在打开的独立 Chrome 窗口中手动登录普通 ChatGPT (chatgpt.com)。');
    console.log('确认登录后会自动保存会话并关闭这个窗口；关闭窗口或 Ctrl+C 可取消。');
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    const deadline = Date.now() + 10 * 60_000;
    let authenticated = false;
    while (!interrupted && browser.isConnected() && Date.now() < deadline) {
      for (const candidate of context.pages()) {
        if (new URL(candidate.url()).origin !== 'https://chatgpt.com') continue;
        // Session response remains inside the page. Only a boolean leaves the browser.
        authenticated = await candidate.evaluate(async () => {
          try {
            const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) });
            if (!response.ok) return false;
            const result = await response.json();
            return !!result?.user && !result.error;
          } catch { return false; }
        }).catch(() => false);
        if (authenticated) break;
      }
      if (authenticated) break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (!authenticated || interrupted) throw new Error('Login was cancelled or timed out.');
    assertPlainPath(destination);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const state = await context.storageState();
    if (interrupted) throw new Error('Login was cancelled.');
    const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
    console.log('ChatGPT 登录会话已保存。现在可运行 web-gateway start。');
    return 0;
  } finally {
    await browser?.close().catch(() => {});
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('message', onMessage);
    process.off('disconnect', stop);
    if (process.connected) process.disconnect();
  }
}

if (require.main === module) {
  if (!process.argv[2] || !path.isAbsolute(process.argv[2])) {
    console.error('[web-gateway] Start login through scripts/web-gateway.mjs.');
    process.exitCode = 1;
  } else {
    login(process.argv[2]).then((code) => { process.exitCode = code; }).catch(() => {
      console.error('[web-gateway] Login did not complete. Check that Chrome is installed, then rerun login. Existing session was preserved.');
      process.exitCode = 1;
    });
  }
}
