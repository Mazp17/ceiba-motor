// Fails when a package's emitted JS exceeds its budget. Measured as gzip of the unminified
// tsc output, so it is an upper bound on what a game ships after its bundler minifies.
import { readdirSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

// Bytes, gzip. core must also stay free of runtime dependencies.
const BUDGETS = { core: 10_000 }

let failed = false
for (const [name, budget] of Object.entries(BUDGETS)) {
  const dir = `packages/${name}/dist`
  const js = readdirSync(dir, { recursive: true }).filter((file) => file.endsWith('.js'))
  const size = gzipSync(Buffer.concat(js.map((file) => readFileSync(`${dir}/${file}`)))).length
  const deps = Object.keys(JSON.parse(readFileSync(`packages/${name}/package.json`, 'utf8')).dependencies ?? {})
  const ok = size <= budget && !(name === 'core' && deps.length)
  console.log(`${ok ? 'ok  ' : 'FAIL'} @ceiba/${name}: ${size} B gzip of ${budget} B (${Math.round((size / budget) * 100)}%), ${deps.length} dependencies`)
  failed ||= !ok
}
process.exit(failed ? 1 : 0)
