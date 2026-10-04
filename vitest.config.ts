import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@chatgpt-to-claude/chatgpt-backend': fileURLToPath(new URL('./packages/chatgpt-backend/src/index.ts', import.meta.url)),
      '@chatgpt-to-claude/claude-protocol': fileURLToPath(new URL('./packages/claude-protocol/src/index.ts', import.meta.url)),
      '@chatgpt-to-claude/protocol-mapper': fileURLToPath(new URL('./packages/protocol-mapper/src/index.ts', import.meta.url)),
      '@chatgpt-to-claude/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url))
    }
  },
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'lcov']
    }
  }
});
