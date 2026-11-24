import { defineConfig } from '@playwright/test'

const PORT = 4173

// Browser smoke test of the sandbox (`pnpm smoke`). Kept apart from the Vitest unit tests by its file name.
export default defineConfig({
  testDir: 'apps/sandbox/smoke',
  testMatch: 'smoke.ts',
  timeout: 90_000,
  expect: { timeout: 60_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: 'chromium',
    // Software GL everywhere, so a local run behaves like CI, which has no GPU.
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  // The production build, not the dev server: no dependency pre-bundling reloads in the middle of a test.
  webServer: {
    // Vite's own binary: behind `pnpm exec` the server outlives Playwright's kill and the run never exits.
    command: `./node_modules/.bin/vite build && ./node_modules/.bin/vite preview --port ${PORT} --strictPort`,
    cwd: 'apps/sandbox',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
