import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const source = (name: string) => fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url))

export default defineConfig({
  // The workspace packages are consumed by source: edits hot-reload with no build or watcher running.
  resolve: { alias: { '@ceiba/core': source('core'), '@ceiba/babylon': source('babylon') } },
})
