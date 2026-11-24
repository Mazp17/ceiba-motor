import {
  type ChunkId,
  chunkDistance,
  chunkKey,
  chunksWithin,
  chunkToScene,
  sceneToChunk,
  shiftOrigin,
  type Vec2,
} from './grid.ts'
import { type ChunkState, transition } from './lifecycle.ts'
import type { ManifestChunk, WorldManifest } from './manifest.ts'
import { loadPriority } from './priority.ts'

/** What the loader hands back for a decoded chunk. */
export interface LoadedChunk<H> {
  /** Measured GPU bytes; replaces the manifest estimate in the budget. */
  gpuBytes: number
  /** Measured RAM bytes; replaces the manifest estimate in the budget. */
  ramBytes: number
  /** Whatever the loader needs to unload the chunk later, e.g. an asset container. */
  handle: H
}

/**
 * The side effects the streamer needs, injected. A load is two steps so each has its own state:
 * `request` (network or cache) then `decode` (parse, upload to the GPU). `H` is the handle type,
 * `D` the intermediate data passed from `request` to `decode`.
 */
export interface ChunkLoader<H, D = unknown> {
  /** Fetches the chunk data. `signal` aborts when the chunk stops being wanted. */
  request(chunk: ManifestChunk, signal: AbortSignal): Promise<D>
  /** Turns the data into a live chunk. If it resolves after `signal` aborted, the streamer unloads the result. */
  decode(data: D, chunk: ManifestChunk, signal: AbortSignal): Promise<LoadedChunk<H>>
  /** Frees a decoded chunk. May be async; its bytes count against the budget until it settles. */
  unload(handle: H): void | Promise<void>
}

/** Options of `createStreamer`. Radii are in chunks (see `chunkDistance`). */
export interface StreamerOptions<H, D = unknown> {
  manifest: WorldManifest
  loader: ChunkLoader<H, D>
  /** GPU budget in bytes, for chunks held plus loads in flight. */
  gpuBudget: number
  /** RAM budget in bytes, for chunks held plus loads in flight. */
  ramBudget: number
  /** Chunks this close to the focus are loaded. Default 2. */
  loadRadius?: number
  /** Chunks further than this are unloaded. Must be greater than `loadRadius`. Default 3. */
  unloadRadius?: number
  /** Loads (requesting or decoding) allowed at once. Default 4. */
  maxConcurrent?: number
  /** Chunks the focus may be from the origin before the origin shifts. Default 2. */
  shiftThreshold?: number
  /** Starting origin chunk. Default `{ cx: 0, cz: 0 }`. */
  origin?: ChunkId
  /** Called on every state change of a chunk, synchronously. */
  onStateChange?(chunk: ManifestChunk, state: ChunkState, previous: ChunkState): void
  /** Called when a load or an unload throws. A chunk whose load failed stays `failed`. */
  onError?(chunk: ManifestChunk, error: unknown): void
}

/** Result of `Streamer.update`. */
export interface StreamerUpdate {
  /**
   * Set when the origin moved in this update: metres to add to every scene position (nodes, physics
   * bodies, cached positions) before the next update. `null` otherwise.
   */
  originShift: Vec2 | null
  /**
   * True while memory does not fit: a chunk inside the load radius is left unloaded, or measured
   * sizes exceed a budget, and nothing outside the load radius is left to evict.
   */
  overBudget: boolean
}

/** One chunk as seen by `Streamer.snapshot`. Chunks in state `unloaded` are not listed. */
export interface ChunkSnapshot extends ChunkId {
  state: ChunkState
  /** Estimated while loading, measured once ready. */
  gpuBytes: number
  ramBytes: number
}

/** Read-only copy of the streamer state, for debug tools. */
export interface StreamerSnapshot {
  /** Bytes held or reserved by every listed chunk. */
  gpuBytes: number
  ramBytes: number
  overBudget: boolean
  chunks: ChunkSnapshot[]
}

/** Decides which chunks are loaded around a moving focus. Created by `createStreamer`. */
export interface Streamer {
  /** Current origin chunk. Changes only inside `update`. */
  readonly origin: ChunkId
  /**
   * Call once per frame or fixed step. `position` is the focus in scene metres relative to `origin`,
   * `velocity` its speed in m/s. Shifts the origin if due, cancels and unloads what is too far,
   * evicts if over budget and starts the most urgent loads.
   */
  update(focus: { position: Vec2; velocity: Vec2 }): StreamerUpdate
  /** Allocates; meant for debug views, not for per-frame game logic. */
  snapshot(): StreamerSnapshot
  /** Cancels every load and unloads every chunk. Resolves when the unloads settle. Do not `update` afterwards. */
  dispose(): Promise<void>
}

interface Entry<H> {
  chunk: ManifestChunk
  state: ChunkState
  gpuBytes: number
  ramBytes: number
  /** Last update in which the chunk was inside the load radius. */
  lastUsed: number
  abort: AbortController
  handle?: H
}

/**
 * Creates a streamer. Nothing loads until the first `update`.
 *
 * Budget policy: a load reserves its manifest estimate first, so memory never exceeds a budget as long
 * as estimates are not below the measured sizes. To make room, least-recently-used ready chunks outside
 * the load radius are evicted. Chunks inside the load radius are never evicted: if they alone do not
 * fit, the lowest-priority ones stay unloaded and `overBudget` is reported.
 */
export function createStreamer<H, D = unknown>(options: StreamerOptions<H, D>): Streamer {
  const { manifest, loader, gpuBudget, ramBudget } = options
  const { loadRadius = 2, unloadRadius = 3, maxConcurrent = 4, shiftThreshold = 2 } = options
  if (unloadRadius <= loadRadius) throw new Error('unloadRadius must be greater than loadRadius')
  const size = manifest.chunkSize
  const world = new Map(manifest.chunks.map((chunk) => [chunkKey(chunk), chunk]))
  /** Every chunk that is not `unloaded`. */
  const entries = new Map<string, Entry<H>>()
  const unloads = new Set<Promise<void>>()
  let origin = options.origin ?? { cx: 0, cz: 0 }
  let focus = origin
  let tick = 0
  let overBudget = false

  function set(entry: Entry<H>, to: ChunkState) {
    const from = entry.state
    entry.state = transition(from, to)
    if (to === 'unloaded') entries.delete(chunkKey(entry.chunk))
    options.onStateChange?.(entry.chunk, to, from)
  }

  async function release(chunk: ManifestChunk, handle: H) {
    try {
      await loader.unload(handle)
    } catch (error) {
      options.onError?.(chunk, error)
    }
  }

  function unload(entry: Entry<H>) {
    set(entry, 'unloading')
    const done = release(entry.chunk, entry.handle as H).then(() => {
      unloads.delete(done)
      set(entry, 'unloaded')
    })
    unloads.add(done)
  }

  /** Stops whatever the chunk is doing and takes it to `unloaded`. */
  function drop(entry: Entry<H>) {
    if (entry.state === 'ready') unload(entry)
    else if (entry.state !== 'unloading') {
      entry.abort.abort()
      set(entry, 'unloaded')
    }
  }

  async function load(chunk: ManifestChunk) {
    const { gpuBytes, ramBytes } = chunk
    const entry: Entry<H> = {
      chunk,
      state: 'unloaded',
      gpuBytes,
      ramBytes,
      lastUsed: tick,
      abort: new AbortController(),
    }
    const { signal } = entry.abort
    entries.set(chunkKey(chunk), entry)
    set(entry, 'requesting')
    try {
      const data = await loader.request(chunk, signal)
      if (signal.aborted) return
      set(entry, 'decoding')
      const loaded = await loader.decode(data, chunk, signal)
      // Cancelled mid-decode but the loader finished anyway: free the result, nobody wants it.
      if (signal.aborted) return void release(chunk, loaded.handle)
      Object.assign(entry, loaded)
      set(entry, 'ready')
    } catch (error) {
      if (signal.aborted) return
      entry.gpuBytes = entry.ramBytes = 0
      set(entry, 'failed')
      options.onError?.(chunk, error)
    }
  }

  /** Would the budgets be exceeded with `gpu`/`ram` more bytes? `freed` leaves out chunks being unloaded. */
  function exceeds(gpu: number, ram: number, freed: boolean) {
    for (const entry of entries.values()) {
      if (freed && entry.state === 'unloading') continue
      gpu += entry.gpuBytes
      ram += entry.ramBytes
    }
    return gpu > gpuBudget || ram > ramBudget
  }

  /** Evicts LRU chunks outside the load radius until the extra bytes fit. False if they cannot. */
  function makeRoom(gpu: number, ram: number) {
    while (exceeds(gpu, ram, true)) {
      let victim: Entry<H> | undefined
      for (const entry of entries.values()) {
        if (entry.state !== 'ready' || entry.lastUsed === tick) continue
        // Among equally old chunks, the farthest goes first.
        const tie = entry.lastUsed === victim?.lastUsed && distance(entry) > distance(victim)
        if (!victim || entry.lastUsed < victim.lastUsed || tie) victim = entry
      }
      if (!victim) return false
      unload(victim)
    }
    return true
  }

  const distance = (entry: Entry<H>) => chunkDistance(entry.chunk, focus)

  return {
    get origin() {
      return origin
    },
    update({ position, velocity }) {
      focus = sceneToChunk(position, origin, size)
      const shift = shiftOrigin(origin, focus, size, shiftThreshold)
      if (shift) {
        origin = shift.origin
        position = { x: position.x + shift.delta.x, z: position.z + shift.delta.z }
      }
      tick++
      let loading = 0
      for (const entry of [...entries.values()]) {
        if (distance(entry) <= loadRadius) entry.lastUsed = tick
        else if (distance(entry) > unloadRadius) drop(entry)
        if (entry.state === 'requesting' || entry.state === 'decoding') loading++
      }

      const queue: { chunk: ManifestChunk; priority: number }[] = []
      for (const id of chunksWithin(focus, loadRadius)) {
        const chunk = world.get(chunkKey(id))
        if (!chunk || entries.has(chunkKey(id))) continue
        const corner = chunkToScene(chunk, origin, size)
        const center = { x: corner.x + size / 2, z: corner.z + size / 2 }
        // The chunk under the focus goes first even when the lookahead point is already past it.
        const priority = chunkDistance(id, focus) === 0 ? -1 : loadPriority(center, position, velocity)
        queue.push({ chunk, priority })
      }
      queue.sort((a, b) => a.priority - b.priority)

      // Measured sizes can be above the estimates that were reserved.
      overBudget = !makeRoom(0, 0)
      for (const { chunk } of queue) {
        if (loading >= maxConcurrent) break
        if (!makeRoom(chunk.gpuBytes, chunk.ramBytes)) {
          overBudget = true
          break
        }
        // Room was made but an unload is still in progress: start on a later update.
        if (exceeds(chunk.gpuBytes, chunk.ramBytes, false)) break
        void load(chunk)
        loading++
      }
      return { originShift: shift?.delta ?? null, overBudget }
    },
    snapshot() {
      const chunks = [...entries.values()].map(({ chunk, state, gpuBytes, ramBytes }) => {
        return { cx: chunk.cx, cz: chunk.cz, state, gpuBytes, ramBytes }
      })
      return {
        gpuBytes: chunks.reduce((sum, chunk) => sum + chunk.gpuBytes, 0),
        ramBytes: chunks.reduce((sum, chunk) => sum + chunk.ramBytes, 0),
        overBudget,
        chunks,
      }
    },
    async dispose() {
      for (const entry of [...entries.values()]) drop(entry)
      await Promise.all(unloads)
    },
  }
}
