import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const packages = fileURLToPath(new URL('../../packages', import.meta.url))

export default defineConfig({
  // The workspace packages are consumed by source: edits hot-reload with no build or watcher running.
  resolve: {
    alias: [
      { find: '@ceiba/debug/babylon', replacement: `${packages}/debug/src/babylon.ts` },
      { find: /^@ceiba\/(\w+)$/, replacement: `${packages}/$1/src/index.ts` },
    ],
  },
})
