import type { Scene } from '@babylonjs/core/scene.js'
import type { Engine, Plugin } from '@ceiba/core'
import {
  type ChunkId,
  type ChunkState,
  chunkKey,
  chunkToScene,
  createStreamer,
  lodManifest,
  type ManifestChunk,
  type Streamer,
  type StreamerOptions,
  type Vec2,
  validateManifest,
} from '@ceiba/streaming'
import { type ChunkHandle, createChunkLoader } from './chunkLoader.ts'

declare module '@ceiba/core' {
  interface EngineEvents {
    /**
     * The origin chunk changed. Chunk roots have already moved; add `delta` (metres) to every other scene
     * position right away: the focus, cameras, physics bodies, cached and interpolated positions.
     */
    'streaming:originShift': { delta: Vec2; origin: ChunkId }
    /** A chunk changed state. */
    'streaming:chunkState': { chunk: ManifestChunk; state: ChunkState; previous: ChunkState }
    /** Emitted when it changes: the wanted chunks stopped (or started again) fitting in the budgets. */
    'streaming:overBudget': { overBudget: boolean }
  }
}

/** Options of `streamingPlugin`. Everything not listed here is passed to `createStreamer` of `@ceiba/streaming`. */
export interface StreamingOptions
  extends Omit<StreamerOptions<unknown>, 'manifest' | 'loader' | 'onStateChange' | 'onError'> {
  /** The scene chunks are added to, e.g. `babylon.scene`. */
  scene: Scene
  /** URL of the world manifest JSON. Chunk URLs are resolved against it. */
  manifestUrl: string
  /** Scene position of what the world streams around: `() => camera.position`. Read every fixed step. */
  focus(): Vec2
  /** Speed of the focus in m/s, for load priority. Default: derived from successive `focus()` positions. */
  velocity?(): Vec2
  /**
   * Streams the `lod` asset of every chunk that has one, in a wider ring with its own budgets, so the
   * distance is never empty. A chunk's low detail is hidden while its full detail is in the scene and
   * stays loaded underneath: detail arriving or leaving swaps the two without a gap.
   */
  lod?: Pick<StreamerOptions<unknown>, 'gpuBudget' | 'ramBudget' | 'loadRadius' | 'unloadRadius' | 'maxConcurrent'>
}

/** The plugin, plus the streamer it created. `streamer` throws until `engine.use()` has resolved. */
export interface StreamingPlugin extends Plugin {
  /** For debug tools: `streamer.snapshot()`, `streamer.origin`. Do not call `update` or `dispose` on it. */
  readonly streamer: Streamer
  /** Removes the system, cancels every load and unloads every chunk. The plugin can be installed again. */
  dispose(): Promise<void>
}

/**
 * Streams the world described by a manifest into a Babylon scene: loads the `.glb` of each chunk around
 * the focus under a root node at the chunk's scene position, and unloads it when it is left behind.
 * Installing is async (it fetches the manifest): `await engine.use(plugin)`.
 *
 * Runs at the start of the `physics` phase (order -100): after the game moved the focus in `update`,
 * before the physics step. On an origin shift it moves the chunk roots and emits
 * `streaming:originShift`; whoever owns anything else in the scene, the focus included, moves it in
 * the handler.
 */
export function streamingPlugin(options: StreamingOptions): StreamingPlugin {
  const { scene, manifestUrl, focus, velocity, lod, ...streamerOptions } = options
  let state: { core: Engine; streamer: Streamer; far?: Streamer } | undefined
  return {
    name: 'streaming',
    get streamer() {
      if (!state) throw new Error('streaming is not installed: await engine.use(plugin) first')
      return state.streamer
    },
    async install(core) {
      if (state) throw new Error('streaming is already installed')
      // Absolute, so chunk URLs resolve against it. Without a page (tests) it must already be absolute.
      const url = new URL(manifestUrl, globalThis.location?.href).href
      const response = await fetch(url)
      if (!response.ok) throw new Error(`world manifest ${url}: HTTP ${response.status}`)
      const manifest = validateManifest(await response.json())

      const place = ({ root, chunk }: ChunkHandle) => {
        const { x, z } = chunkToScene(chunk, streamer.origin, manifest.chunkSize)
        root.position.set(x, 0, z)
      }
      const loader = createChunkLoader(scene, url, place)
      const onError = (chunk: ManifestChunk, error: unknown) =>
        core.log.error(`chunk ${chunk.cx},${chunk.cz} (${chunk.url}) failed`, error)
      /** Chunks whose full detail is in the scene. */
      const detailed = new Set<string>()
      const farLoader = createChunkLoader(scene, url, place, 'lod')
      const swap = () => {
        for (const { root, chunk } of farLoader.handles) root.setEnabled(!detailed.has(chunkKey(chunk)))
      }
      const streamer = createStreamer({
        ...streamerOptions,
        manifest,
        loader,
        onStateChange(chunk, state, previous) {
          if (state === 'ready') detailed.add(chunkKey(chunk))
          else detailed.delete(chunkKey(chunk))
          swap()
          core.events.emit('streaming:chunkState', { chunk, state, previous })
        },
        onError,
      })
      // A second streamer over the low-detail assets. Same origin and threshold, fed the same focus: it shifts
      // on the same update as the first.
      const { origin, shiftThreshold } = streamerOptions
      const far =
        lod &&
        createStreamer({
          ...lod,
          origin,
          shiftThreshold,
          manifest: lodManifest(manifest),
          loader: farLoader,
          onStateChange: swap,
          onError,
        })

      let previous: Vec2 | undefined
      let wasOverBudget = false
      core.addSystem({
        name: 'streaming',
        phase: 'physics',
        order: -100,
        update({ dt }) {
          const { x, z } = focus()
          const speed =
            velocity?.() ?? (previous ? { x: (x - previous.x) / dt, z: (z - previous.z) / dt } : { x: 0, z: 0 })
          far?.update({ position: { x, z }, velocity: speed })
          const { originShift, overBudget } = streamer.update({ position: { x, z }, velocity: speed })
          previous = { x: x + (originShift?.x ?? 0), z: z + (originShift?.z ?? 0) }
          if (originShift) {
            // Recomputed from the integer indices, not accumulated: no drift however many shifts.
            for (const handle of loader.handles) place(handle)
            for (const handle of farLoader.handles) place(handle)
            core.events.emit('streaming:originShift', { delta: originShift, origin: streamer.origin })
          }
          if (overBudget !== wasOverBudget) core.events.emit('streaming:overBudget', { overBudget })
          wasOverBudget = overBudget
        },
      })
      state = { core, streamer, far }
    },
    async dispose() {
      if (!state) return
      const { core, streamer, far } = state
      state = undefined
      core.removeSystem('streaming')
      await Promise.all([streamer.dispose(), far?.dispose()])
    },
  }
}
