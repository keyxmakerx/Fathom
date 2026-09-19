import { defineConfig } from 'vitest/config'

// Vitest, not another runner: it reads this project's own Vite transform
// pipeline, needs no separate bundler configuration, and the WebCrypto
// primitives the crypto test exercises are a Node global it already exposes
// — no jsdom or browser environment required for that test.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
