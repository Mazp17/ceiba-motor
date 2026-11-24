import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '@babylonjs/core/scene.js'
import { Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer/decoder'
import sharp from 'sharp'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createChunkLoader } from '../../../packages/babylon/src/chunkLoader.ts'
import { type ChunkAsset, validateManifest, type WorldManifest } from '../../../packages/streaming/src/index.ts'
import { buildWorld, LOD_TEXTURE } from '../src/pipeline.ts'

const CHUNK_SIZE = 100
const dir = mkdtempSync(join(tmpdir(), 'pipeline-'))
let manifest: WorldManifest
afterAll(() => rmSync(dir, { recursive: true }))

/**
 * The source world, in glTF coordinates (scene x is minus glTF x). Scene-space footprints:
 * - `near`: a textured 40 x 20 m grid of 800 triangles at x 10..50, z 10..30, under a translated parent: chunk (0, 0)
 * - `far`: the same mesh at x 210..250, z -90..-70: chunk (2, -1), also at 10..50, 10..30 inside it
 * - `quad`: a 5 m quad scaled by 2 at x -60..-50, z 0..10: chunk (-1, 0), at 40..50, 0..10 inside it
 */
beforeAll(async () => {
  const document = new Document()
  const buffer = document.createBuffer()
  const plane = (width: number, depth: number, cells: number, name: string) => {
    const positions: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    for (let j = 0; j <= cells; j++) {
      for (let i = 0; i <= cells; i++) {
        positions.push((i / cells) * width, 0, (j / cells) * depth)
        uvs.push(i / cells, j / cells)
      }
    }
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const a = j * (cells + 1) + i
        // Counter-clockwise seen from +y, as glTF wants.
        indices.push(a, a + cells + 1, a + 1, a + 1, a + cells + 1, a + cells + 2)
      }
    }
    const primitive = document
      .createPrimitive()
      .setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer)) // biome-ignore format: one line
      .setAttribute('TEXCOORD_0', document.createAccessor().setType('VEC2').setArray(new Float32Array(uvs)).setBuffer(buffer)) // biome-ignore format: one line
      .setIndices(document.createAccessor().setArray(new Uint16Array(indices)).setBuffer(buffer))
    return { primitive, mesh: document.createMesh(name).addPrimitive(primitive) }
  }

  const image = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#c63' } })
    .png()
    .toBuffer()
  const texture = document.createTexture('paint').setImage(image).setMimeType('image/png')
  const grid = plane(40, 20, 20, 'grid')
  grid.primitive.setMaterial(document.createMaterial('painted').setBaseColorTexture(texture))
  const quad = plane(5, 5, 1, 'quad')

  const parent = document.createNode('district').setTranslation([-50, 0, 0])
  parent.addChild(document.createNode('near').setMesh(grid.mesh).setTranslation([0, 0, 10]))
  const far = document.createNode('far').setMesh(grid.mesh).setTranslation([-250, 0, -90])
  const small = document.createNode('quad').setMesh(quad.mesh).setTranslation([50, 0, 0]).setScale([2, 2, 2])
  document.createScene().addChild(parent).addChild(far).addChild(small)

  const source = join(dir, 'world.glb')
  await new NodeIO().write(source, document)
  manifest = await buildWorld(source, join(dir, 'out'), CHUNK_SIZE, 'webp')
})

const file = (asset: ChunkAsset) => readFileSync(join(dir, 'out', asset.url))
const chunk = (cx: number, cz: number) => {
  const found = manifest.chunks.find((c) => c.cx === cx && c.cz === cz)
  if (!found?.lod) throw new Error(`no chunk ${cx},${cz} with a lod`)
  return { ...found, lod: found.lod }
}

/** Loads an asset the way the engine does and returns its scene-space bounds, triangle count and measured GPU bytes. */
async function load(asset: ChunkAsset) {
  const loader = createChunkLoader(new Scene(new NullEngine()), 'https://test/manifest.json', () => {}, 'chunk', MeshoptDecoder) // biome-ignore format: one line
  const decoded = await loader.decode(new Uint8Array(file(asset)), chunk(0, 0), new AbortController().signal)
  const { min, max } = decoded.handle.root.getHierarchyBoundingVectors()
  const triangles = decoded.handle.container.meshes.reduce((sum, mesh) => sum + mesh.getTotalIndices() / 3, 0)
  return { bounds: [min.x, max.x, min.z, max.z], triangles, gpuBytes: decoded.gpuBytes }
}

const expectBounds = (actual: number[], expected: number[]) => {
  for (const [i, value] of expected.entries()) expect(actual[i]).toBeCloseTo(value, 1)
}

test('the manifest validates, lists only chunks with content and its hashes match the files', () => {
  expect(validateManifest(JSON.parse(readFileSync(join(dir, 'out/manifest.json'), 'utf8')))).toEqual(manifest)
  expect(manifest.chunkSize).toBe(CHUNK_SIZE)
  expect(manifest.chunks.map((c) => `${c.cx}_${c.cz}`).sort()).toEqual(['-1_0', '0_0', '2_-1'])
  expect(readdirSync(join(dir, 'out/chunks')).sort()).toEqual(
    ['-1_0', '0_0', '2_-1'].flatMap((key) => [`${key}.glb`, `${key}.lod.glb`]),
  )
  for (const { lod, ...detail } of manifest.chunks.map((c) => chunk(c.cx, c.cz))) {
    expect([detail.url, lod.url]).toEqual([`chunks/${detail.cx}_${detail.cz}.glb`, `chunks/${detail.cx}_${detail.cz}.lod.glb`]) // biome-ignore format: one line
    for (const asset of [detail, lod])
      expect(asset.hash).toBe(createHash('sha256').update(file(asset)).digest('hex').slice(0, 16))
  }
})

test('every mesh lands in its chunk, in chunk-local coordinates and not mirrored, once Babylon loads it', async () => {
  // Meshopt-compressed and quantized: this is also the adapter decoding what the pipeline writes.
  expectBounds((await load(chunk(0, 0))).bounds, [10, 50, 10, 30])
  expectBounds((await load(chunk(2, -1))).bounds, [10, 50, 10, 30])
  expectBounds((await load(chunk(-1, 0))).bounds, [40, 50, 0, 10])
  expectBounds((await load(chunk(0, 0).lod)).bounds, [10, 50, 10, 30])
})

test('the lod has fewer triangles and smaller textures, and estimates are of decoded sizes', async () => {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
  const read = async (asset: ChunkAsset) => (await io.readBinary(new Uint8Array(file(asset)))).getRoot()
  const { lod, ...detail } = chunk(0, 0)
  const [full, low] = [await load(detail), await load(lod)]
  expect(full.triangles).toBe(800)
  expect(low.triangles).toBeLessThan(full.triangles / 4)

  const [fullRoot, lowRoot] = [await read(detail), await read(lod)]
  expect(fullRoot.listExtensionsRequired().map((extension) => extension.extensionName)).toEqual(
    expect.arrayContaining(['EXT_meshopt_compression', 'EXT_texture_webp']),
  )
  expect(fullRoot.listTextures().map((texture) => [texture.getMimeType(), texture.getSize()])).toEqual([['image/webp', [512, 512]]]) // biome-ignore format: one line
  expect(lowRoot.listTextures().map((texture) => texture.getSize())).toEqual([[LOD_TEXTURE, LOD_TEXTURE]])

  // 512 x 512 RGBA8 with mipmaps is 1.4 MB, far more than the file: the estimate is of memory, not download.
  expect(detail.gpuBytes).toBeGreaterThan(512 * 512 * 4)
  expect(detail.gpuBytes).toBeGreaterThan(10 * file(detail).byteLength)
  expect(lod.gpuBytes).toBeLessThan(detail.gpuBytes / 3)
  expect(detail.ramBytes).toBeGreaterThan(file(detail).byteLength)

  // No textures in this chunk: the estimate is what Babylon holds for the geometry.
  const quad = chunk(-1, 0)
  expect(quad.gpuBytes).toBe((await load(quad)).gpuBytes)
})
