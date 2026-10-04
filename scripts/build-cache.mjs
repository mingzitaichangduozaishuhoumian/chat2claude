import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const cacheVersion = 1;
const cacheFile = (root) => path.join(root, 'node_modules/.cache/chat2claude/build.json');

function workspaces(root) {
  return ['apps', 'packages'].flatMap((parent) => fs.readdirSync(path.join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, parent, entry.name, 'package.json')))
    .map((entry) => `${parent}/${entry.name}`)).sort();
}

function files(root, directory) {
  if (!fs.existsSync(path.join(root, directory))) return [];
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return files(root, relative);
    if (entry.isSymbolicLink() && !fs.statSync(path.join(root, relative)).isFile()) throw new Error('Build-cache directories must not be symbolic links.');
    return [relative];
  });
}

function fingerprint(root, paths) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([cacheVersion, process.versions.node, process.platform, process.arch]));
  for (const relative of [...new Set(paths)].sort()) {
    const file = path.join(root, relative);
    const content = fs.existsSync(file) ? fs.readFileSync(file) : null;
    hash.update(JSON.stringify([relative, content?.length ?? null]));
    if (content) hash.update(content);
  }
  return hash.digest('hex');
}

function sources(root) {
  return fingerprint(root, ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json',
    'scripts/build-cache.mjs', 'scripts/build.mjs', 'scripts/start.mjs', 'node_modules/typescript/package.json',
    ...workspaces(root).flatMap((directory) => [`${directory}/package.json`, `${directory}/tsconfig.json`, ...files(root, `${directory}/src`)]),
  ]);
}

function outputs(root) {
  const packages = workspaces(root);
  for (const directory of packages) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, directory, 'package.json'), 'utf8'));
    if (!pkg.main?.startsWith('dist/') || !fs.existsSync(path.join(root, directory, pkg.main))) return null;
  }
  return fingerprint(root, packages.flatMap((directory) => files(root, `${directory}/dist`)));
}

function compile(root) {
  const cli = process.env.npm_execpath;
  if (!cli || !/^pnpm\.(?:c?js)$/.test(path.basename(cli)) || !fs.existsSync(cli)) {
    throw new Error('Run this command with corepack pnpm start or corepack pnpm build.');
  }
  execFileSync(process.execPath, [cli, '-r', 'build'], { cwd: root, windowsHide: true, stdio: 'inherit' });
}

/** Record only a successful build of unchanged inputs. Failed builds cannot
 * leave a reusable cache; output fingerprints also catch partial/deleted dist.
 */
export function ensureBuild({ root = projectRoot, force = false, runBuild = compile, log = console.log } = {}) {
  const source = sources(root);
  let cached;
  try { cached = JSON.parse(fs.readFileSync(cacheFile(root), 'utf8')); } catch { /* First build or invalid cache. */ }
  if (!force && cached?.version === cacheVersion && cached.source === source && cached.output && cached.output === outputs(root)) {
    log('[start] Build is up to date; skipping TypeScript compilation.');
    return { rebuilt: false };
  }
  fs.rmSync(cacheFile(root), { force: true });
  log('[build] Compiling workspace packages...');
  runBuild(root);
  if (sources(root) !== source) throw new Error('Source changed during compilation. Run the command again before starting.');
  const output = outputs(root);
  if (!output) throw new Error('Build did not produce all workspace entry points.');
  const file = cacheFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: cacheVersion, source, output }) + '\n');
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return { rebuilt: true };
}
