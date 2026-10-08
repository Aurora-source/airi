import { fileURLToPath } from 'node:url'

import templateCompilerOptions from '@tresjs/core/template-compiler-options'
import Vue from '@vitejs/plugin-vue'
import Unocss from 'unocss/vite'

import { presetMini } from 'unocss'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [Vue(templateCompilerOptions), Unocss({ presets: [presetMini()] })],
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
  build: { outDir: '../dist-demo', emptyOutDir: true },
})
