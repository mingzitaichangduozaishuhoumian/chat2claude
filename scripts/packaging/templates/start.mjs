import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const version = process.versions.node.match(/^(\d+)\.(\d+)\.(\d+)$/);
const major = Number(version?.[1]);
const minor = Number(version?.[2]);
if (!version || !(major === 22 && minor >= 15 || major >= 24)) {
  console.error('This release requires Node.js 22.15+ (22.x), or Node.js 24+.');
  process.exitCode = 1;
} else {
  const root = path.dirname(fileURLToPath(import.meta.url));
  process.chdir(root);
  const dotenv = path.join(root, '.env');
  if (fs.existsSync(dotenv)) process.loadEnvFile(dotenv);
  // Node's dotenv loader keeps existing environment values unchanged.
  if (!process.env.CHATGPT_BACKEND?.trim()) process.env.CHATGPT_BACKEND = 'session';
  if (!process.env.HOST?.trim()) process.env.HOST = '127.0.0.1';
  if (!process.env.PORT?.trim()) process.env.PORT = '3000';
  process.env.DATA_DIR = path.resolve(root, process.env.DATA_DIR?.trim() || 'data');
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  await import(pathToFileURL(path.join(root, 'app', 'dist', 'index.js')).href);
}
