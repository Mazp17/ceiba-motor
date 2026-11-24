import type { AssetContainer } from '@babylonjs/core/assetContainer.js'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader.js'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import type { Scene } from '@babylonjs/core/scene.js'
import { RegisterGLTF2Loader } from '@babylonjs/loaders/glTF/2.0/glTFLoader.pure.js'
import { RegisterGLTFFileLoader } from '@babylonjs/loaders/glTF/glTFFileLoader.pure.js'
import { type ChunkLoader, chunkKey, type ManifestChunk } from '@ceiba/streaming'

/** A chunk living in the scene: everything in its `.glb` hangs from `root`. */
export interface ChunkHandle {
  chunk: ManifestChunk
  root: TransformNode
  container: AssetContainer
}

const CACHE = 'ceiba-chunks'
const HASH = 'x-ceiba-hash'

// Internal: `streamingPlugin` is the public way in. `place` positions a new root; `handles` is every chunk in the
// scene; roots are named `<prefix>:<cx>,<cz>`.
export function createChunkLoader(
  scene: Scene,
  manifestUrl: string,
  place: (handle: ChunkHandle) => void,
  prefix = 'chunk',
): ChunkLoader<ChunkHandle, Uint8Array> & { handles: Set<ChunkHandle> } {
  // The pure modules plus an explicit, idempotent registration instead of the side-effect import
  // `@babylonjs/loaders/glTF/2.0/glTFLoader.js`: this package stays `sideEffects: false` for real.
  RegisterGLTF2Loader()
  RegisterGLTFFileLoader()
  const handles = new Set<ChunkHandle>()
  // No Cache API (insecure context, Node) or a browser that refuses it: plain fetch.
  const cache: Promise<Cache | undefined> = (async () => globalThis.caches?.open(CACHE))().catch(() => undefined)

  return {
    handles,
    async request(chunk, signal) {
      const url = new URL(chunk.url, manifestUrl).href
      // One entry per chunk URL, tagged with the manifest hash: a new hash is a miss and the fresh
      // download overwrites the entry, so old versions never pile up.
      // shortcut: entries of chunks removed from the manifest stay until the browser evicts them;
      // prune against the manifest if worlds start dropping many chunks.
      const store = await cache
      const hit = await store?.match(url).catch(() => undefined)
      if (hit?.headers.get(HASH) === chunk.hash) return new Uint8Array(await hit.arrayBuffer())
      const response = await fetch(url, { signal })
      if (!response.ok) throw new Error(`chunk ${url}: HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      // Not awaited and allowed to fail (quota): the cache is only an optimisation.
      store?.put(url, new Response(bytes, { headers: { [HASH]: chunk.hash } })).catch(() => {})
      return bytes
    },
    async decode(bytes, chunk, signal) {
      const container = await LoadAssetContainerAsync(bytes, scene, { pluginExtension: '.glb' })
      // Babylon cannot abort a parse. Cancelled meanwhile: free it before anything reaches the scene.
      if (signal.aborted) {
        container.dispose()
        throw signal.reason
      }
      // Added before it is parented: the container warns about parents it does not own.
      container.addAllToScene()
      const root = new TransformNode(`${prefix}:${chunkKey(chunk)}`, scene)
      for (const node of container.rootNodes) node.parent = root
      const handle = { chunk, root, container }
      place(handle)
      handles.add(handle)
      return { handle, ...measure(container, bytes) }
    },
    unload(handle) {
      handles.delete(handle)
      handle.container.dispose()
      handle.root.dispose()
    },
  }
}

/**
 * Estimate, not a measurement: WebGL and WebGPU do not report memory.
 * GPU: vertex attributes and indices as uploaded, plus every texture as uncompressed RGBA8 with mipmaps
 * (too high for compressed textures). RAM: the `.glb` itself, which stays alive because Babylon keeps
 * the geometry arrays, and they are views into it. Babylon's own objects are not counted.
 */
function measure(container: AssetContainer, bytes: Uint8Array) {
  let gpuBytes = 0
  for (const geometry of container.geometries) {
    for (const buffer of Object.values(geometry.getVertexBuffers() ?? {}))
      gpuBytes += geometry.getTotalVertices() * buffer.getSize(true)
    const indices = geometry.getIndices()
    if (indices) gpuBytes += indices.length * (ArrayBuffer.isView(indices) ? indices.BYTES_PER_ELEMENT : 4)
  }
  for (const texture of container.textures) {
    const { width, height } = texture.getSize()
    gpuBytes += Math.ceil((width * height * 4 * 4) / 3)
  }
  return { gpuBytes, ramBytes: bytes.byteLength }
}
