import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { uxAliases } from './scripts/ux-aliases.mjs'

const { version } = JSON.parse(readFileSync('package.json', 'utf-8'))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [vue()],
    define: {
      __APP_VERSION__: JSON.stringify(version)
    },
    resolve: {
      alias: [
        // UxKit：本地直连 ../UX-FRW，无上游时回退 vendor/uxkit
        ...uxAliases(),
        { find: '@', replacement: resolve('src/renderer/src') }
      ]
    }
  }
})
