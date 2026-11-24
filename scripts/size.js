// Fails when a package's emitted JS exceeds its budget. Measured as gzip of the unminified
// tsc output, so it is an upper bound on what a game ships after its bundler minifies.
import { readdirSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

// Bytes, gzip, of the package's own code: what it imports (Babylon) is not counted.
// No package bundles anything, so none may have `dependencies`: Babylon and other @ceiba packages
// are peers, installed once by the game.
// streaming measured 3.9 kB as pure logic; twice that means it stopped being simple.
// babylon measured 4.1 kB: 1.5 kB of render glue plus 2.6 kB of streaming adapter (chunk loader and
// plugin). Both are glue, so 6 kB is the same "one and a half times what it took" alarm as before.
const BUDGETS = { core: 10_000, streaming: 8_000, babylon: 6_000 }
// Pure logic: these must have no peers either.
const NO_PEERS = ['core', 'streaming']

let failed = false
for (const [name, budget] of Object.entries(BUDGETS)) {
  const dir = `packages/${name}/dist`
  const js = readdirSync(dir, { recursive: true }).filter((file) => file.endsWith('.js'))
  const size = gzipSync(Buffer.concat(js.map((file) => readFileSync(`${dir}/${file}`)))).length
  const pkg = JSON.parse(readFileSync(`packages/${name}/package.json`, 'utf8'))
  const deps = Object.keys(pkg.dependencies ?? {})
  const peers = Object.keys(pkg.peerDependencies ?? {})
  const ok = size <= budget && !deps.length && !(NO_PEERS.includes(name) && peers.length)
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} @ceiba/${name}: ${size} B gzip of ${budget} B (${Math.round((size / budget) * 100)}%), ${deps.length} dependencies, ${peers.length} peers`,
  )
  failed ||= !ok
}
process.exit(failed ? 1 : 0)
