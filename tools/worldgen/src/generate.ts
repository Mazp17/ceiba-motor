import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Document, NodeIO } from '@gltf-transform/core'
// Streaming by source: the tool runs with no build, and the package's exports point at its dist.
import {
  type ChunkAsset,
  type ManifestChunk,
  validateManifest,
  type WorldManifest,
} from '../../../packages/streaming/src/index.ts'

export interface WorldOptions {
  /** Side of the world, in chunks. The world is centred on chunk (0, 0). */
  size: number
  /** Side of a chunk, in metres. */
  chunkSize: number
  seed: number
}

type Vec3 = [number, number, number]

/** Chunk-local scene position of the orientation post: near the minimum corner. */
export const MARKER = { x: 10, z: 10, height: 40 }
/** The post and its arm are the only geometry with this vertex colour. */
export const MARKER_COLOR: Vec3 = [1, 0, 0.5]

// Chunks share one density per 4 x 4 block, so the world has empty and dense districts.
const BLOCK = 4
const MAX_BUILDINGS = 48
const HOLE_CHANCE = 0.03
/** The low-detail chunk keeps the ground and the buildings at least this tall, in metres. */
export const LOD_MIN_HEIGHT = 25

/** Hashes integers to [0, 1). */
function hash(...values: number[]): number {
  let h = 0x9e3779b9
  for (const value of values) {
    h = Math.imul(h ^ value, 0x85ebca6b)
    h ^= h >>> 13
    h = Math.imul(h, 0xc2b2ae35)
    h ^= h >>> 16
  }
  return (h >>> 0) / 2 ** 32
}

/** Seeded generator of numbers in [0, 1) (mulberry32). */
function createRandom(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

/** Whether the chunk is left out of the world. Chunk (0, 0) always exists, so there is ground to start on. */
export function isHole(cx: number, cz: number, seed: number): boolean {
  return (cx !== 0 || cz !== 0) && hash(seed, cx, cz, 1) < HOLE_CHANCE
}

/**
 * Builds one chunk as a .glb. Geometry is described in the chunk's scene frame (x and z in
 * [0, chunkSize], y up) and written with x negated: Babylon's glTF loader mirrors x when it loads
 * into a left-handed scene, which puts it back. `lod` builds the low-detail version: the same ground
 * and tall buildings, without the marker and the small buildings.
 */
export async function buildChunk(
  cx: number,
  cz: number,
  { chunkSize, seed }: Omit<WorldOptions, 'size'>,
  lod = false,
): Promise<{ glb: Uint8Array; gpuBytes: number }> {
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const indices: number[] = []

  // Corners in perimeter order, either direction.
  const quad = (corners: [Vec3, Vec3, Vec3, Vec3], normal: Vec3, color: Vec3) => {
    const base = positions.length / 3
    for (const [x, y, z] of corners) {
      positions.push(-x, y, z)
      normals.push(-normal[0], normal[1], normal[2])
      colors.push(...color)
    }
    // glTF front faces are counter-clockwise: (b - a) x (c - a) must point along the normal, in glTF's frame.
    const [a, b, c] = corners.map(([x, y, z]) => [-x, y, z] as Vec3) as [Vec3, Vec3, Vec3]
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as Vec3
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as Vec3
    const facing =
      (u[1] * v[2] - u[2] * v[1]) * -normal[0] +
      (u[2] * v[0] - u[0] * v[2]) * normal[1] +
      (u[0] * v[1] - u[1] * v[0]) * normal[2]
    indices.push(...(facing > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]).map((i) => base + i))
  }

  // No bottom face: nothing looks at a box from below.
  const box = ([x0, y0, z0]: Vec3, [x1, y1, z1]: Vec3, color: Vec3) => {
    quad([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0], color) // biome-ignore format: one face per line
    quad([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], [-1, 0, 0], color) // biome-ignore format: one face per line
    quad([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0], color) // biome-ignore format: one face per line
    quad([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [0, 0, -1], color) // biome-ignore format: one face per line
    quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], color) // biome-ignore format: one face per line
  }

  const random = createRandom(Math.floor(hash(seed, cx, cz, 2) * 2 ** 32))

  // Ground: a checker with a per-chunk tint, so every chunk border shows.
  const shade = (cx + cz) % 2 === 0 ? 0.3 : 0.55
  const ground: Vec3 = [shade * (0.6 + 0.4 * random()), shade, shade * (0.6 + 0.4 * random())]
  quad([[0, 0, 0], [chunkSize, 0, 0], [chunkSize, 0, chunkSize], [0, 0, chunkSize]], [0, 1, 0], ground) // biome-ignore format: one line

  // Orientation marker: a post near the minimum corner, with an arm at the top pointing along +x.
  const { x, z, height } = MARKER
  if (!lod) {
    box([x - 0.5, 0, z - 0.5], [x + 0.5, height, z + 0.5], MARKER_COLOR)
    box([x + 0.5, height - 2, z - 0.5], [x + 6, height, z + 0.5], MARKER_COLOR)
  }

  const density = hash(seed, Math.floor(cx / BLOCK), Math.floor(cz / BLOCK), 3)
  const buildings = Math.floor(density ** 2 * MAX_BUILDINGS * (0.5 + random()))
  for (let i = 0; i < buildings; i++) {
    const width = 6 + 24 * random()
    const depth = 6 + 24 * random()
    // From 20 m in: clear of the marker.
    const x0 = 20 + (chunkSize - 20 - width) * random()
    const z0 = 20 + (chunkSize - 20 - depth) * random()
    const grey = 0.5 + 0.4 * random()
    const top = 4 + 80 * density * random()
    // Every random number is drawn either way, so both versions agree on what they share.
    if (!lod || top >= LOD_MIN_HEIGHT) box([x0, 0, z0], [x0 + width, top, z0 + depth], [grey, grey, grey * 0.9])
  }

  const document = new Document()
  const buffer = document.createBuffer()
  const accessor = (array: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>, type: 'VEC3' | 'SCALAR') =>
    document.createAccessor().setType(type).setArray(array).setBuffer(buffer)
  // shortcut: 16-bit indices cap a chunk at 65,535 vertices (it has under 1,500), switch to Uint32Array if content grows.
  const arrays = [new Float32Array(positions), new Float32Array(normals), new Float32Array(colors), new Uint16Array(indices)] as const // biome-ignore format: one line
  const primitive = document
    .createPrimitive()
    .setAttribute('POSITION', accessor(arrays[0], 'VEC3'))
    .setAttribute('NORMAL', accessor(arrays[1], 'VEC3'))
    .setAttribute('COLOR_0', accessor(arrays[2], 'VEC3'))
    .setIndices(accessor(arrays[3], 'SCALAR'))
    .setMaterial(document.createMaterial('flat').setRoughnessFactor(1).setMetallicFactor(0))
  document
    .createScene()
    .addChild(document.createNode('chunk').setMesh(document.createMesh('chunk').addPrimitive(primitive)))

  return {
    glb: await new NodeIO().writeBinary(document),
    // What the loaded chunk uploads: the vertex and index buffers, uncompressed.
    gpuBytes: arrays.reduce((sum, array) => sum + array.byteLength, 0),
  }
}

/** Writes `manifest.json` and, per chunk, `chunks/<cx>_<cz>.glb` and its `.lod.glb` into `out`, replacing a previous world there. */
export async function generateWorld(out: string, options: WorldOptions): Promise<WorldManifest> {
  const { size, chunkSize, seed } = options
  if (!Number.isInteger(size) || size < 1) throw new Error('size must be a positive integer')
  if (!(chunkSize >= 64)) throw new Error('chunkSize must be at least 64: buildings are up to 30 m wide')
  if (!Number.isInteger(seed)) throw new Error('seed must be an integer')

  rmSync(join(out, 'chunks'), { recursive: true, force: true })
  mkdirSync(join(out, 'chunks'), { recursive: true })

  const chunks: ManifestChunk[] = []
  const min = -Math.floor(size / 2)
  for (let cz = min; cz < min + size; cz++) {
    for (let cx = min; cx < min + size; cx++) {
      if (isHole(cx, cz, seed)) continue
      const asset = async (url: string, lod: boolean): Promise<ChunkAsset> => {
        const { glb, gpuBytes } = await buildChunk(cx, cz, options, lod)
        writeFileSync(join(out, url), glb)
        return {
          url,
          hash: createHash('sha256').update(glb).digest('hex').slice(0, 16),
          gpuBytes,
          // Upper bound: the fetched file plus a CPU-side copy of every buffer.
          ramBytes: glb.byteLength + gpuBytes,
        }
      }
      const detail = await asset(`chunks/${cx}_${cz}.glb`, false)
      chunks.push({ cx, cz, ...detail, lod: await asset(`chunks/${cx}_${cz}.lod.glb`, true) })
    }
  }

  const manifest = validateManifest({ version: 1, chunkSize, chunks })
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest))
  return manifest
}
