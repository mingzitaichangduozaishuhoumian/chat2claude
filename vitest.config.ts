import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@chatgpt-to-claude/chatgpt-backend': new URL('./packages/chatgpt-backend/src/index.ts', import.meta.url).pathname,
      '@chatgpt-to-claude/claude-protocol': new URL('./packages/claude-protocol/src/index.ts', import.meta.url).pathname,
      '@chatgpt-to-claude/protocol-mapper': new URL('./packages/protocol-mapper/src/index.ts', import.meta.url).pathname,
      '@chatgpt-to-claude/shared': new URL('./packages/shared/src/index.ts', import.meta.url).pathname
    }
  },
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'lcov']
    }
  }
});
