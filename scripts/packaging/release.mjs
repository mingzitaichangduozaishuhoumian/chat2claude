import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { checkDistribution, cleanupTemp, git, json, materializeDeployment, pnpm, root, sha256, slash, tempDirectory, writeJson } from './common.mjs';
import { extractTar, extractZip, tarDirectory, zipDirectory } from './archives.mjs';

const NODE_VERSION = '24.21.0';
const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64.zip`;
const NODE_BASE = `https://nodejs.org/download/release/v${NODE_VERSION}/`;
const NODE_SHA256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541';
const args = process.argv.slice(2).filter((arg) => arg !== '--');
let output = path.join(root, 'dist-release');
let allowDirty = false;
let nodeArchive;
let nodeShasums;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--allow-dirty') allowDirty = true;
  else if (['--out', '--node-archive', '--node-shasums'].includes(args[index]) && args[index + 1]) {
    const key = args[index++]; const value = path.resolve(args[index]);
    if (key === '--out') output = value;
    else if (key === '--node-archive') nodeArchive = value;
    else nodeShasums = value;
  } else throw new Error(`Unknown/incomplete packaging argument: ${args[index]}`);
}
const pkg = json(path.join(root, 'package.json'));
const packageManager = `pnpm@${pnpm(['--version'], { stdio: 'pipe', encoding: 'utf8' }).trim()}`;
if (packageManager !== pkg.packageManager) throw new Error('Use the exact packageManager version declared by this repository.');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('Invalid release version.');
for (const name of ['apps/api', 'packages/chatgpt-backend', 'packages/claude-protocol', 'packages/protocol-mapper', 'packages/shared']) {
  if (json(path.join(root, name, 'package.json')).version !== pkg.version) throw new Error('All workspace packages must share the release version.');
}
const dirty = git(['status', '--porcelain=v1', '--untracked-files=all']).length > 0;
if (dirty && !allowDirty) throw new Error('Release builds require a clean checkout. Use --allow-dirty only for a marked preflight build.');
const source = { commit: git(['rev-parse', 'HEAD']), dirty };
const owned = tempDirectory('release');

async function download(url, target, maxBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Official runtime download failed: HTTP ${response.status}`);
  let bytes = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > maxBytes ? new Error('Official runtime download exceeded the byte limit.') : null, chunk);
  } }), fs.createWriteStream(target, { flags: 'wx' }));
}
function checksumFor(text, filename) {
  const line = text.split(/\r?\n/).find((line) => line.slice(66) === filename);
  if (!line || !/^[a-f0-9]{64}  /.test(line)) throw new Error(`Official checksum missing for ${filename}`);
  return line.slice(0, 64);
}

try {
  console.log(`Building chat2claude ${pkg.version} (${source.commit.slice(0, 12)}${dirty ? ', DIRTY PREFLIGHT' : ''})`);
  const snapshot = path.join(owned.directory, 'source');
  fs.mkdirSync(snapshot);
  if (!dirty) {
    const tracked = path.join(owned.directory, 'source.tar');
    execFileSync('git', ['archive', '--format=tar', '--output', tracked, source.commit], { cwd: root, windowsHide: true });
    await extractTar(tracked, snapshot);
  } else {
    const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
    for (const relative of new Set(tracked)) {
      const from = path.join(root, relative);
      if (!fs.existsSync(from)) continue;
      if (!fs.lstatSync(from).isFile()) throw new Error('Dirty preflight source snapshots require regular files.');
      const to = path.join(snapshot, relative);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
  for (const name of ['apps/api', 'packages/chatgpt-backend', 'packages/claude-protocol', 'packages/protocol-mapper', 'packages/shared']) {
    if (fs.existsSync(path.join(snapshot, name, 'dist'))) throw new Error('Source snapshots must not contain tracked build output.');
  }
  // Dependencies were already installed with the release lockfile in the source
  // checkout/CI. Build in a fresh snapshot, never reusing ignored workspace dist.
  pnpm(['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--prod=false'], { cwd: snapshot });
  pnpm(['build'], { cwd: snapshot });
  const deploy = path.join(owned.directory, 'deploy');
  pnpm(['--filter', '@chatgpt-to-claude/api', 'deploy', '--prod', deploy], { cwd: snapshot });
  const base = path.join(owned.directory, 'node-package');
  fs.mkdirSync(base);
  const dependencies = materializeDeployment(deploy, path.join(base, 'app'), path.join(snapshot, 'LICENSE'));
  const publicFiles = ['.env.example', 'README.md', 'README.en.md', 'CHANGELOG.md', 'INSTALL.md', 'LICENSE', 'SUPPORT.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'config/models.json', 'docs/USAGE.zh-CN.md', 'docs/USAGE.en.md', 'docs/protocol-compatibility.md'];
  for (const relative of publicFiles) {
    const target = path.join(base, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(snapshot, relative), target);
  }
  for (const name of ['start.mjs', 'start.bat', 'start.sh']) fs.copyFileSync(path.join(snapshot, 'scripts/packaging/templates', name), path.join(base, name));
  fs.chmodSync(path.join(base, 'start.sh'), 0o755);
  const provenance = { schemaVersion: 1, name: pkg.name, version: pkg.version, source, requiredNode: pkg.engines.node,
    build: { node: process.versions.node, packageManager: pkg.packageManager, platform: process.platform, arch: process.arch },
    license: { spdx: 'MIT', file: 'LICENSE' }, dependencies };
  const notes = '# Third-party licenses\n\nProduction dependency licenses are preserved at these paths:\n\n'
    + dependencies.map((item) => `- ${item.name}@${item.version} — ${item.license}: ${item.licenseFiles.map((file) => `[license](${file})`).join(', ')}`).join('\n') + '\n';
  fs.writeFileSync(path.join(base, 'THIRD_PARTY_LICENSES.md'), notes);
  writeJson(path.join(base, 'release-manifest.json'), { ...provenance, target: 'node', runtime: { bundled: false, requiredNode: pkg.engines.node } });
  checkDistribution(base);

  const archivePath = nodeArchive ?? path.join(owned.directory, NODE_ARCHIVE);
  const checksumsPath = nodeShasums ?? path.join(owned.directory, 'SHASUMS256.txt');
  if (!nodeShasums) await download(NODE_BASE + 'SHASUMS256.txt', checksumsPath, 256 * 1024);
  const shasums = fs.readFileSync(checksumsPath, 'utf8');
  const officialHash = checksumFor(shasums, NODE_ARCHIVE);
  if (officialHash !== NODE_SHA256) throw new Error('Official runtime checksum differs from the reviewed release checksum.');
  if (!nodeArchive) await download(NODE_BASE + NODE_ARCHIVE, archivePath, 256 * 1024 * 1024);
  if (await sha256(archivePath) !== officialHash) throw new Error('Official Node.js archive checksum mismatch.');
  const runtimeExtract = path.join(owned.directory, 'runtime');
  const prefix = `node-v${NODE_VERSION}-win-x64`;
  await extractZip(archivePath, runtimeExtract, (name) => name === `${prefix}/node.exe` || name === `${prefix}/LICENSE`);
  const nodeExe = path.join(runtimeExtract, prefix, 'node.exe');
  const executableSha256 = await sha256(nodeExe);
  if (executableSha256 !== checksumFor(shasums, 'win-x64/node.exe')) throw new Error('Official Node.js executable checksum mismatch.');
  const windows = path.join(owned.directory, 'windows-package');
  fs.cpSync(base, windows, { recursive: true, dereference: true });
  fs.mkdirSync(path.join(windows, 'runtime'));
  fs.copyFileSync(nodeExe, path.join(windows, 'runtime/node.exe'));
  fs.copyFileSync(path.join(runtimeExtract, prefix, 'LICENSE'), path.join(windows, 'runtime/LICENSE.node.txt'));
  const runtime = { bundled: true, version: NODE_VERSION, platform: 'win32', arch: 'x64', sourceUrl: NODE_BASE + NODE_ARCHIVE,
    sha256: officialHash, executableSha256, licenseFile: 'runtime/LICENSE.node.txt' };
  writeJson(path.join(windows, 'release-manifest.json'), { ...provenance, target: 'windows-x64', runtime });
  fs.appendFileSync(path.join(windows, 'THIRD_PARTY_LICENSES.md'), '\nNode.js and its bundled components: [Node.js license](runtime/LICENSE.node.txt).\n');
  checkDistribution(windows);
  const artifactDir = path.join(owned.directory, 'artifacts');
  fs.mkdirSync(artifactDir);
  const name = `chat2claude-v${pkg.version}`;
  const artifacts = [];
  for (const [filename, directory, format, target] of [[`${name}-node.zip`, base, 'zip', 'node'], [`${name}-node.tar.gz`, base, 'tar', 'node'], [`${name}-windows-x64.zip`, windows, 'zip', 'windows-x64']]) {
    const file = path.join(artifactDir, filename);
    if (format === 'zip') await zipDirectory(directory, file); else await tarDirectory(directory, file);
    artifacts.push({ file: filename, target, bytes: fs.statSync(file).size, sha256: await sha256(file) });
  }
  writeJson(path.join(artifactDir, 'release-manifest.json'), { ...provenance, runtimes: { node: { bundled: false, requiredNode: pkg.engines.node }, 'windows-x64': runtime }, artifacts });
  fs.writeFileSync(path.join(artifactDir, 'SHA256SUMS'), [...artifacts.map((item) => `${item.sha256}  ${item.file}`), `${await sha256(path.join(artifactDir, 'release-manifest.json'))}  release-manifest.json`].join('\n') + '\n');
  fs.mkdirSync(output, { recursive: true });
  for (const file of fs.readdirSync(artifactDir)) fs.copyFileSync(path.join(artifactDir, file), path.join(output, file));
  console.log(`Created ${artifacts.length} archives, release-manifest.json and SHA256SUMS in ${slash(path.relative(root, output)) || '.'}`);
} finally { cleanupTemp(owned); }
