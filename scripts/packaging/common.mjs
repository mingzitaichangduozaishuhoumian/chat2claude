import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const slash = (value) => value.split(path.sep).join('/');
export const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
export function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
export function tempDirectory(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `chat2claude-${label}-`));
  const token = randomUUID();
  fs.writeFileSync(path.join(directory, '.packaging-owner'), token);
  return { directory, token };
}
/** Only delete a temp tree created by this invocation, after checking its real path and marker. */
export function cleanupTemp(owned) {
  if (!fs.existsSync(owned.directory)) return;
  const resolved = fs.realpathSync(owned.directory);
  if (fs.lstatSync(owned.directory).isSymbolicLink() || !within(fs.realpathSync(os.tmpdir()), resolved)
    || !path.basename(resolved).startsWith('chat2claude-')
    || fs.readFileSync(path.join(resolved, '.packaging-owner'), 'utf8') !== owned.token) {
    throw new Error('Refusing to remove an unowned packaging directory.');
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function filesBelow(directory, relative = '') {
  return fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Distribution must not contain symbolic links: ${slash(name)}`);
    if (entry.isDirectory()) return filesBelow(directory, name);
    if (!entry.isFile()) throw new Error(`Unsupported distribution entry: ${slash(name)}`);
    return [name];
  });
}
export function git(args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim(); }
export function pnpm(args, options = {}) {
  const cli = process.env.npm_execpath;
  if (!cli || !/^pnpm\.(?:c?js)$/.test(path.basename(cli)) || !fs.existsSync(cli)) {
    throw new Error('Run this builder with corepack pnpm package:release.');
  }
  return execFileSync(process.execPath, [cli, ...args], { cwd: root, windowsHide: true, stdio: 'inherit', ...options });
}

const forbiddenParts = new Set(['.git', '.omc', '.claude', 'test', 'tests', '__tests__', '__fixtures__', 'coverage']);
const forbiddenPackages = /^(?:typescript|tsx|vite|vitest|playwright(?:-core)?|yazl|yauzl|tar|esbuild|@vitest\/|@esbuild\/)/;
function permitted(relative) {
  const parts = slash(relative).split('/');
  const name = parts.at(-1);
  return !parts.some((part) => forbiddenParts.has(part)) && !parts.includes('node_modules')
    && !/\.test\.[^.]+(?:\.map)?$|\.test\.d\.ts(?:\.map)?$|\.map$|\.tsbuildinfo$/.test(name)
    && !/^\.env(?:\.|$)/.test(name) && !['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc', '.pnpmfile.cjs'].includes(name);
}

/** pnpm deploy resolves the production graph. Materialize that graph as regular
 * files without its symlinks or virtual-store paths, retaining original JS modules.
 */
export function materializeDeployment(deployRoot, destination, projectLicense) {
  const sourceRoot = fs.realpathSync(deployRoot);
  const inventory = new Map();
  const top = new Map();
  const dependencies = (pkg) => new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
  const locate = (from, name) => {
    if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid dependency name.');
    let current = from;
    while (current === sourceRoot || within(sourceRoot, current)) {
      const candidate = path.join(current, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) {
        const real = fs.realpathSync(candidate);
        if (!within(sourceRoot, real)) throw new Error(`Dependency escapes production deployment: ${name}`);
        return real;
      }
      current = path.dirname(current);
    }
    return undefined;
  };
  const app = json(path.join(sourceRoot, 'package.json'));
  for (const name of dependencies(app)) {
    const source = locate(sourceRoot, name);
    if (source) top.set(name, source);
  }
  const copyPackage = (source, target, ancestors = []) => {
    const pkg = json(path.join(source, 'package.json'));
    if (!pkg.name || !pkg.version || forbiddenPackages.test(pkg.name)) throw new Error(`Unexpected production dependency: ${pkg.name ?? 'unnamed'}`);
    fs.cpSync(source, target, { recursive: true, dereference: true, filter: (entry) => {
      const relative = path.relative(source, entry);
      if (relative && !permitted(relative)) return false;
      const real = fs.realpathSync(entry);
      if (real !== sourceRoot && !within(sourceRoot, real)) throw new Error('Package file escapes production deployment.');
      return true;
    } });
    const deployed = { ...pkg };
    delete deployed.devDependencies;
    delete deployed.packageManager;
    if (deployed.scripts) deployed.scripts = deployed.scripts.start ? { start: deployed.scripts.start } : {};
    for (const group of ['dependencies', 'optionalDependencies']) if (deployed[group]) {
      deployed[group] = Object.fromEntries(Object.entries(deployed[group]).map(([name, range]) => {
        const dependency = locate(source, name);
        return [name, String(range).startsWith('workspace:') && dependency ? json(path.join(dependency, 'package.json')).version : range];
      }));
    }
    writeJson(path.join(target, 'package.json'), deployed);
    if (pkg.name.startsWith('@chatgpt-to-claude/')) fs.copyFileSync(projectLicense, path.join(target, 'LICENSE'));
    const location = slash(path.relative(path.dirname(destination), target));
    const licenseFiles = fs.readdirSync(target).filter((name) => /^(?:licen[sc]e|copying|notice)(?:[.-]|$)/i.test(name) && fs.statSync(path.join(target, name)).isFile()).map((name) => `${location}/${name}`);
    if (!licenseFiles.length) throw new Error(`No license file found for ${pkg.name}@${pkg.version}`);
    const key = `${pkg.name}@${pkg.version}`;
    const record = inventory.get(key) ?? { name: pkg.name, version: pkg.version, license: typeof pkg.license === 'string' ? pkg.license : 'SEE LICENSE FILE', locations: [], licenseFiles: [] };
    record.locations.push(location); record.licenseFiles.push(...licenseFiles); inventory.set(key, record);
    const chain = [...ancestors, { name: pkg.name, source }];
    for (const name of dependencies(pkg)) {
      const dependency = locate(source, name);
      if (!dependency) {
        if (pkg.optionalDependencies?.[name] || pkg.peerDependenciesMeta?.[name]?.optional) continue;
        throw new Error(`Production dependency missing: ${pkg.name} -> ${name}`);
      }
      if (source !== sourceRoot && top.get(name) === dependency || chain.some((parent) => parent.name === name && parent.source === dependency)) continue;
      copyPackage(dependency, path.join(target, 'node_modules', name), chain);
    }
  };
  copyPackage(sourceRoot, destination);
  const files = filesBelow(destination);
  if (files.some((file) => /\.node$/i.test(file))) throw new Error('Universal packages cannot contain platform-specific native addons.');
  return [...inventory.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function checkDistribution(directory) {
  const files = filesBelow(directory);
  for (const file of files) {
    const parts = slash(file).split('/');
    const name = parts.at(-1);
    if (parts.some((part) => forbiddenParts.has(part)) || /\.test\.|\.map$/.test(name)
      || /^\.env(?:\.|$)/.test(name) && slash(file) !== '.env.example'
      || /^(?:runtime-state|admin-operational-state)\.json$/.test(name)
      || parts[0] === 'data') throw new Error(`Private/development file in distribution: ${slash(file)}`);
  }
  return files;
}
