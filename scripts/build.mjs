import { ensureBuild } from './build-cache.mjs';

const args = process.argv.slice(2).filter((value) => value !== '--');
try {
  if (args.some((value) => value !== '--if-needed')) throw new Error('Usage: corepack pnpm build [--if-needed]');
  ensureBuild({ force: !args.includes('--if-needed') });
} catch (error) {
  console.error('[build]', error.message);
  process.exitCode = 1;
}
