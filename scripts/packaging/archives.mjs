import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import yauzl from 'yauzl';
import * as tar from 'tar';
import { filesBelow, slash, within } from './common.mjs';

function entryPath(root, name) {
  if (!name || name.includes('\\') || /[\u0000-\u001f:]/.test(name) || path.posix.isAbsolute(name)
    || name.split('/').some((part) => part === '..')) throw new Error('Unsafe archive path.');
  const target = path.resolve(root, name);
  if (!within(root, target)) throw new Error('Archive entry escapes extraction directory.');
  return target;
}

export async function zipDirectory(directory, file) {
  const archive = new yazl.ZipFile();
  archive.on('error', (error) => archive.outputStream.destroy(error));
  const completion = pipeline(archive.outputStream, fs.createWriteStream(file, { flags: 'wx' }));
  for (const relative of filesBelow(directory)) {
    const source = path.join(directory, relative);
    archive.addFile(source, slash(relative), { mtime: new Date('1980-01-01T00:00:00Z'), mode: fs.statSync(source).mode });
  }
  archive.end();
  await completion;
}

export async function tarDirectory(directory, file) {
  await tar.c({ cwd: directory, file, gzip: true, portable: true, noMtime: true }, filesBelow(directory).map(slash));
}

export async function extractZip(file, directory, include = () => true) {
  fs.mkdirSync(directory, { recursive: true });
  const archive = await yauzl.openPromise(file);
  let bytes = 0;
  let count = 0;
  try {
    for await (const entry of archive.eachEntry()) {
      const target = entryPath(directory, entry.fileName);
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (type && type !== 0o100000 && type !== 0o040000) throw new Error('Archive links and special files are not supported.');
      if (!include(entry.fileName)) continue;
      bytes += entry.uncompressedSize;
      if (++count > 25_000 || bytes > 1024 * 1024 * 1024 || entry.uncompressedSize > 512 * 1024 * 1024) throw new Error('Archive extraction limit exceeded.');
      if (entry.fileName.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const input = await archive.openReadStreamPromise(entry);
      const mode = ((entry.externalFileAttributes >>> 16) & 0o777) || 0o644;
      await pipeline(input, fs.createWriteStream(target, { flags: 'wx', mode }));
      fs.chmodSync(target, mode);
    }
  } finally { archive.close(); }
}

export async function extractTar(file, directory) {
  fs.mkdirSync(directory, { recursive: true });
  let bytes = 0;
  let count = 0;
  const seen = new Set();
  await tar.x({ file, cwd: directory, strict: true, chmod: true, filter: (name, entry) => {
    entryPath(directory, name);
    if (!['File', 'Directory'].includes(entry.type)) throw new Error('Archive links and special files are not supported.');
    if (seen.has(name)) throw new Error('Duplicate archive entry.');
    seen.add(name);
    bytes += entry.size;
    if (++count > 25_000 || bytes > 1024 * 1024 * 1024 || entry.size > 512 * 1024 * 1024) throw new Error('Archive extraction limit exceeded.');
    return true;
  } });
}
