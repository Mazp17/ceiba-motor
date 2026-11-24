import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  // Agent worktrees live under .claude/ and hold full copies of the repo, tests included.
  test: { exclude: [...configDefaults.exclude, '**/.claude/**'] },
  // By source: `pnpm test` runs without a build, and the workspace links point at each package's dist.
  resolve: {
    alias: [{ find: /^@ceiba\/(\w+)$/, replacement: `${import.meta.dirname}/packages/$1/src/index.ts` }],
  },
})
