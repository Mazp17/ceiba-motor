import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  // Agent worktrees live under .claude/ and hold full copies of the repo, tests included.
  test: { exclude: [...configDefaults.exclude, '**/.claude/**'] },
})
