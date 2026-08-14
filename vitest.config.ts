import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    exclude: ['node_modules/**', 'dist/**', 'deepseek-harness/**', 'qaq-test-plugins/**'],
  },
})
