import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureBuild, projectRoot } from './build-cache.mjs';

try {
  ensureBuild();
  // Preserve the API workspace's existing relative DATA_DIR/config behavior.
  // Import in this process so Ctrl+C reaches the API's own shutdown handlers.
  process.chdir(path.join(projectRoot, 'apps/api'));
  await import(pathToFileURL(path.join(process.cwd(), 'dist/index.js')).href);
} catch (error) {
  console.error('[start]', error.message);
  process.exitCode = 1;
}
