import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureBuild } from './build-cache.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2claude-build-cache-'));
  t.after(() => {
    const real = fs.realpathSync(root);
    assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir()));
    assert(path.basename(real).startsWith('chat2claude-build-cache-'));
    fs.rmSync(real, { recursive: true, force: true });
  });
  const write = (file, value) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), value); };
  const packages = ['apps/api', 'packages/shared'];
  for (const directory of packages) {
    write(`${directory}/package.json`, JSON.stringify({ name: directory, main: 'dist/index.js' }));
    write(`${directory}/tsconfig.json`, '{}');
    write(`${directory}/src/index.ts`, 'export const value = 1;');
  }
  write('package.json', '{}');
  write('pnpm-lock.yaml', 'lockfileVersion: 9');
  write('pnpm-workspace.yaml', 'packages: [apps/*, packages/*]');
  write('tsconfig.base.json', '{}');
  let builds = 0;
  const runBuild = () => {
    builds++;
    for (const directory of packages) {
      write(`${directory}/dist/index.js`, fs.readFileSync(path.join(root, directory, 'src/index.ts')));
      write(`${directory}/dist/helper.js`, 'export {};');
    }
  };
  return { root, write, runBuild, builds: () => builds,
    cache: path.join(root, 'node_modules/.cache/chat2claude/build.json'),
    ensure: (options = {}) => ensureBuild({ root, runBuild, log() {}, ...options }),
  };
}

test('first launch builds once; unchanged inputs and runtime-only settings reuse it', (t) => {
  const f = fixture(t);
  assert.equal(f.ensure().rebuilt, true);
  assert.equal(f.ensure().rebuilt, false);
  f.write('README.md', 'Documentation only');
  f.write('.env', 'PORT=3100');
  f.write('config/models.json', '{"aliases":[]}');
  assert.equal(f.ensure().rebuilt, false);
  assert.equal(f.builds(), 1);
});

test('source edits with unchanged timestamps and size still rebuild', (t) => {
  const f = fixture(t);
  f.ensure();
  const file = path.join(f.root, 'packages/shared/src/index.ts');
  const before = fs.statSync(file);
  f.write('packages/shared/src/index.ts', 'export const value = 2;');
  fs.utimesSync(file, before.atime, before.mtime);
  assert.equal(f.ensure().rebuilt, true);
  assert.equal(f.builds(), 2);
});

test('added or deleted source files invalidate the build', (t) => {
  const f = fixture(t);
  f.ensure();
  f.write('apps/api/src/extra.ts', 'export {};');
  assert.equal(f.ensure().rebuilt, true);
  fs.unlinkSync(path.join(f.root, 'apps/api/src/extra.ts'));
  assert.equal(f.ensure().rebuilt, true);
});

test('compiler, workspace, dependency and launcher inputs invalidate the build', (t) => {
  const f = fixture(t);
  f.ensure();
  for (const file of ['tsconfig.base.json', 'apps/api/tsconfig.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'scripts/build-cache.mjs', 'scripts/start.mjs', 'node_modules/typescript/package.json']) {
    f.write(file, 'changed');
    assert.equal(f.ensure().rebuilt, true, file);
  }
  f.write('packages/shared/package.json', JSON.stringify({ name: 'shared', main: 'dist/index.js', version: '2' }));
  assert.equal(f.ensure().rebuilt, true);
});

test('missing or modified compiled files rebuild even when sources are unchanged', (t) => {
  const f = fixture(t);
  f.ensure();
  f.write('apps/api/dist/index.js', 'broken compiled output');
  assert.equal(f.ensure().rebuilt, true);
  fs.unlinkSync(path.join(f.root, 'packages/shared/dist/helper.js'));
  assert.equal(f.ensure().rebuilt, true);
  fs.unlinkSync(path.join(f.root, 'apps/api/dist/index.js'));
  assert.equal(f.ensure().rebuilt, true);
});

test('failed or incomplete builds never create a reusable cache', (t) => {
  const f = fixture(t);
  f.ensure();
  assert.throws(() => f.ensure({ force: true, runBuild: () => { throw new Error('compile failed'); } }), /compile failed/);
  assert.equal(fs.existsSync(f.cache), false);
  assert.equal(f.ensure().rebuilt, true);
  fs.unlinkSync(path.join(f.root, 'apps/api/dist/index.js'));
  assert.throws(() => f.ensure({ runBuild() {} }), /entry points/);
  assert.equal(fs.existsSync(f.cache), false);
});

test('editing source during compilation does not certify a stale build', (t) => {
  const f = fixture(t);
  assert.throws(() => f.ensure({ runBuild: () => { f.runBuild(); f.write('apps/api/src/index.ts', 'new source'); } }), /Source changed/);
  assert.equal(fs.existsSync(f.cache), false);
  assert.equal(f.ensure().rebuilt, true);
});

test('manual forced builds and invalid cache recovery remain available', (t) => {
  const f = fixture(t);
  f.ensure();
  assert.equal(f.ensure({ force: true }).rebuilt, true);
  fs.writeFileSync(f.cache, '{corrupt');
  assert.equal(f.ensure().rebuilt, true);
  fs.writeFileSync(f.cache, JSON.stringify({ version: 999 }));
  assert.equal(f.ensure().rebuilt, true);
  assert.equal(f.ensure().rebuilt, false);
});
