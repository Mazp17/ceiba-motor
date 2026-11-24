import { parseArgs } from 'node:util'
import { generateWorld } from './generate.ts'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    size: { type: 'string', default: '64' },
    'chunk-size': { type: 'string', default: '256' },
    seed: { type: 'string', default: '1' },
  },
})
if (!values.out) {
  console.error('usage: node src/cli.ts --out <dir> [--size 64] [--chunk-size 256] [--seed 1]')
  process.exit(1)
}

const size = Number(values.size)
const start = performance.now()
const manifest = await generateWorld(values.out, {
  size,
  chunkSize: Number(values['chunk-size']),
  seed: Number(values.seed),
})
const fileBytes = (asset?: { ramBytes: number; gpuBytes: number }) => (asset ? asset.ramBytes - asset.gpuBytes : 0)
const bytes = manifest.chunks.reduce((sum, chunk) => sum + fileBytes(chunk) + fileBytes(chunk.lod), 0)
console.log(
  `${manifest.chunks.length} chunks (${size * size - manifest.chunks.length} holes), ` +
    `${(bytes / 1e6).toFixed(1)} MB, ${((size * manifest.chunkSize) / 1000).toFixed(1)} km across, ` +
    `${((performance.now() - start) / 1000).toFixed(1)} s → ${values.out}`,
)
