import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Document, ImageUtils, Logger, type Mesh, type Node, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, EXTTextureWebP, KHRTextureBasisu } from '@gltf-transform/extensions'
import { cloneDocument, copyToDocument, getTextureColorSpace, meshopt, simplify, weld } from '@gltf-transform/functions'
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'
// Streaming by source: the tool runs with no build, and the package's exports point at its dist.
import {
  type ChunkAsset,
  type ManifestChunk,
  validateManifest,
  type WorldManifest,
} from '../../../packages/streaming/src/index.ts'

/** The low-detail chunk keeps about this fraction of the vertices... */
const LOD_RATIO = 0.1
/** ...unless that moves the surface more than this fraction of the mesh radius. */
const LOD_ERROR = 0.05
/** Longest side of a low-detail texture, in pixels. */
export const LOD_TEXTURE = 256

export type TextureFormat = 'ktx2' | 'webp'

/** Re-encodes every texture of the document, at most `maxSize` pixels on its longest side. */
async function compressTextures(document: Document, format: TextureFormat, maxSize?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'ceiba-ktx-'))
  try {
    for (const texture of document.getRoot().listTextures()) {
      const image = texture.getImage()
      if (!image) continue
      const pixels = sharp(image)
      if (maxSize) pixels.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
      if (format === 'webp') {
        texture.setImage(await pixels.webp().toBuffer()).setMimeType('image/webp')
        continue
      }
      const [png, ktx] = [join(dir, 'in.png'), join(dir, 'out.ktx2')]
      writeFileSync(png, await pixels.ensureAlpha().png().toBuffer())
      // Colour textures are sRGB; normals, roughness and the like must not be gamma-decoded.
      const srgb = getTextureColorSpace(texture) === 'srgb'
      // UASTC: transcodes to BC7 or ASTC at 8 bits per pixel and survives normal maps.
      const colour = ['--format', srgb ? 'R8G8B8A8_SRGB' : 'R8G8B8A8_UNORM', '--assign-tf', srgb ? 'srgb' : 'linear']
      execFileSync('ktx', ['create', ...colour, '--encode', 'uastc', '--zstd', '18', '--generate-mipmap', png, ktx])
      texture.setImage(readFileSync(ktx)).setMimeType('image/ktx2')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  if (format === 'webp') document.createExtension(EXTTextureWebP).setRequired(true)
  else document.createExtension(KHRTextureBasisu).setRequired(true)
}

/**
 * Chunk of a mesh node: the one holding the centre of its bounding box. Babylon's glTF loader mirrors x
 * when it loads into a left-handed scene, so scene x is minus glTF x: the grid is laid over the world as
 * Babylon would show the source file.
 */
function chunkOf(node: Node, mesh: Mesh, chunkSize: number): { cx: number; cz: number } {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute('POSITION')
    if (!position) continue
    const [low, high] = [position.getMinNormalized([]), position.getMaxNormalized([])]
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i] as number, low[i] as number)
      max[i] = Math.max(max[i] as number, high[i] as number)
    }
  }
  // The centre of a box stays the centre of its bounds under any affine transform.
  const [x, y, z] = min.map((value, i) => (value + (max[i] as number)) / 2) as [number, number, number]
  const m = node.getWorldMatrix()
  return {
    cx: Math.floor(-(m[0] * x + m[4] * y + m[8] * z + m[12]) / chunkSize),
    cz: Math.floor((m[2] * x + m[6] * y + m[10] * z + m[14]) / chunkSize),
  }
}

/**
 * Splits the document into one document per chunk, in chunk-local coordinates: every mesh node becomes a
 * root node with its world transform baked in, moved so the chunk's minimum corner is the origin.
 * Animations, skins, cameras and lights are dropped.
 */
function split(source: Document, chunkSize: number): Map<string, Document> {
  // shortcut: a mesh goes whole to the chunk of its centre, triangles are never cut at chunk borders, so
  // a mesh larger than a chunk (terrain) sticks out of it and unloads all at once; cut meshes here if
  // artists cannot pre-split them.
  const groups = new Map<string, { cx: number; cz: number; nodes: Node[] }>()
  const root = source.getRoot()
  for (const scene of root.getDefaultScene() ? [root.getDefaultScene()] : root.listScenes()) {
    scene?.traverse((node) => {
      const mesh = node.getMesh()
      if (!mesh?.listPrimitives().some((primitive) => primitive.getAttribute('POSITION'))) return
      const { cx, cz } = chunkOf(node, mesh, chunkSize)
      const group = groups.get(`${cx}_${cz}`) ?? { cx, cz, nodes: [] }
      groups.set(`${cx}_${cz}`, group)
      group.nodes.push(node)
    })
  }

  const chunks = new Map<string, Document>()
  for (const [key, { cx, cz, nodes }] of groups) {
    const document = new Document().setLogger(source.getLogger())
    for (const extension of root.listExtensionsUsed()) {
      const type = extension.constructor as Parameters<Document['createExtension']>[0]
      document.createExtension(type).setRequired(extension.isRequired())
    }
    const meshes = [...new Set(nodes.map((node) => node.getMesh() as Mesh))]
    const copies = copyToDocument(document, source, meshes)
    const scene = document.createScene()
    for (const node of nodes) {
      const matrix = node.getWorldMatrix()
      // x is negated in the file (see `chunkOf`), so the chunk's corner is added, not subtracted.
      matrix[12] += cx * chunkSize
      matrix[14] -= cz * chunkSize
      const copy = document.createNode(node.getName()).setMatrix(matrix).setExtras(node.getExtras())
      scene.addChild(copy.setMesh(copies.get(node.getMesh() as Mesh) as Mesh))
    }
    chunks.set(key, document)
  }
  return chunks
}

/**
 * Turns one source `.glb` into a streamable world in `out`: `manifest.json` and, per chunk with content,
 * `chunks/<cx>_<cz>.glb` and its `.lod.glb`, Meshopt-compressed. A previous world there is replaced.
 */
export async function buildWorld(
  input: string,
  out: string,
  chunkSize: number,
  // shortcut: 'ktx2' needs the `ktx` CLI of KTX-Software, has never been run and @ceiba/babylon cannot load it yet.
  textures: TextureFormat = 'webp',
): Promise<WorldManifest> {
  if (!(chunkSize > 0)) throw new Error('chunkSize must be a positive number')
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready])
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder })

  // Textures and simplification run once on the whole world, so what chunks share is processed once.
  // Warnings only: the transforms report every step, once per chunk.
  const detail = (await io.read(input)).setLogger(new Logger(Logger.Verbosity.WARN))
  const lod = cloneDocument(detail)
  await compressTextures(detail, textures)
  await lod.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: LOD_RATIO, error: LOD_ERROR }))
  await compressTextures(lod, textures, LOD_TEXTURE)

  rmSync(join(out, 'chunks'), { recursive: true, force: true })
  mkdirSync(join(out, 'chunks'), { recursive: true })

  const write = async (document: Document, url: string): Promise<ChunkAsset> => {
    // Quantizes too, so the sizes below are the decoded ones: what Babylon holds after it decompresses.
    await document.transform(meshopt({ encoder: MeshoptEncoder }))
    const glb = await io.writeBinary(document)
    writeFileSync(join(out, url), glb)
    const root = document.getRoot()
    const geometry = root.listAccessors().reduce((sum, accessor) => sum + accessor.getByteLength(), 0)
    // Uncompressed RGBA8 with mipmaps, or the transcoded block size for KTX2.
    const pixels = root.listTextures().reduce((sum, texture) => {
      const image = texture.getImage()
      return sum + ((image && ImageUtils.getVRAMByteLength(image, texture.getMimeType())) ?? 0)
    }, 0)
    return {
      url,
      hash: createHash('sha256').update(glb).digest('hex').slice(0, 16),
      gpuBytes: geometry + pixels,
      // Upper bound: the fetched file plus a CPU-side copy of every decoded buffer.
      ramBytes: glb.byteLength + geometry,
    }
  }

  const lods = split(lod, chunkSize)
  const chunks: ManifestChunk[] = []
  for (const [key, document] of split(detail, chunkSize)) {
    const [cx, cz] = key.split('_').map(Number) as [number, number]
    const asset = await write(document, `chunks/${key}.glb`)
    chunks.push({ cx, cz, ...asset, lod: await write(lods.get(key) as Document, `chunks/${key}.lod.glb`) })
  }

  const manifest = validateManifest({ version: 1, chunkSize, chunks })
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest))
  return manifest
}
