import { parseArgs } from 'node:util'
import { buildWorld } from './pipeline.ts'

const { values } = parseArgs({
  options: {
    in: { type: 'string' },
    out: { type: 'string' },
    'chunk-size': { type: 'string', default: '256' },
    ktx2: { type: 'boolean', default: false },
  },
})
if (!values.in || !values.out) {
  console.error('usage: node src/cli.ts --in <world.glb> --out <dir> [--chunk-size 256] [--ktx2]')
  process.exit(1)
}

const textures = values.ktx2 ? 'ktx2' : 'webp'
const start = performance.now()
const manifest = await buildWorld(values.in, values.out, Number(values['chunk-size']), textures)
const sum = (pick: (chunk: (typeof manifest.chunks)[number]) => number) =>
  manifest.chunks.reduce((n, c) => n + pick(c), 0)
console.log(
  `${manifest.chunks.length} chunks, ${(sum((c) => c.gpuBytes) / 1e6).toFixed(1)} MB GPU in full detail, ` +
    `${(sum((c) => c.lod?.gpuBytes ?? 0) / 1e6).toFixed(1)} MB in low detail, ` +
    `${((performance.now() - start) / 1000).toFixed(1)} s → ${values.out}`,
)
