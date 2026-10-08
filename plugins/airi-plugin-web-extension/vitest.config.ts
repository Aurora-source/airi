import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'airi-plugin-web-extension',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
