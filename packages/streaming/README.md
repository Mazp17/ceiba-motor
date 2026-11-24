# @ceiba/streaming

Decides which chunks of a large world are loaded around the player: chunk grid and floating
origin, per-chunk lifecycle, load priority, GPU and RAM budgets with LRU eviction. Pure logic:
no Babylon, no DOM, no network, no timers, no dependencies. It talks to the outside through a
loader you inject; the Babylon adapter is `streamingPlugin` in `@ceiba/babylon`.

> Early development. The API changes without notice and the package is not on npm yet.

## Quick start

```ts
import { type ChunkLoader, createStreamer, validateManifest } from '@ceiba/streaming'

const manifest = validateManifest(await (await fetch('/world/manifest.json')).json())

// Stand-ins for the game's own code.
declare function parseChunk(data: ArrayBuffer): Promise<{ dispose(): void }>
declare function moveEverything(dx: number, dz: number): void
declare const player: { position: { x: number; z: number }; velocity: { x: number; z: number } }

const loader: ChunkLoader<{ dispose(): void }, ArrayBuffer> = {
  request: async (chunk, signal) => (await fetch(chunk.url, { signal })).arrayBuffer(),
  decode: async (data, chunk) => {
    const handle = await parseChunk(data)
    return { gpuBytes: chunk.gpuBytes, ramBytes: data.byteLength, handle }
  },
  unload: (handle) => handle.dispose(),
}

const streamer = createStreamer({ manifest, loader, gpuBudget: 512e6, ramBudget: 256e6 })

// Every fixed step, before physics:
const { originShift, overBudget } = streamer.update({ position: player.position, velocity: player.velocity })
if (originShift) moveEverything(originShift.x, originShift.z)
if (overBudget) console.warn('world does not fit in the memory budgets')
```

## Coordinates

A chunk is identified by integer indices `(cx, cz)` and everything inside it is stored in
chunk-local metres. No absolute float position is stored anywhere. The scene only sees positions
relative to an origin chunk: `(chunk - originChunk) * chunkSize`.

```ts
import { chunkKey, chunksWithin, chunkToScene, sceneToChunk, shiftOrigin } from '@ceiba/streaming'

const origin = { cx: 100, cz: -40 }
chunkToScene({ cx: 102, cz: -41 }, origin, 256) // { x: 512, z: -256 }, the chunk's minimum corner
sceneToChunk({ x: 600, z: -10 }, origin, 256) // { cx: 102, cz: -41 }
chunkKey({ cx: 102, cz: -41 }) // '102,-41'
chunksWithin(origin, 1) // the 9 chunks around it

shiftOrigin(origin, { cx: 102, cz: -40 }, 256) // null: 2 chunks away is within the threshold
shiftOrigin(origin, { cx: 103, cz: -40 }, 256) // { origin: { cx: 103, cz: -40 }, delta: { x: -768, z: 0 } }
```

`update()` takes the focus as a **scene position relative to `streamer.origin`**, because that is
what a Babylon node or a physics body already holds, and it is always a small number. The
streamer owns the origin. When the focus is more than `shiftThreshold` chunks from it (default 2),
the origin snaps to the focus chunk and `update()` returns `originShift`: add it to every scene
position (nodes, physics bodies, the position you pass next time) before the next update. A
threshold above 1 keeps a focus that hovers on a chunk border from shifting back and forth.

Distances between chunks count diagonals as 1 (`chunkDistance`), so a radius of 2 is a 5 × 5 square.

## Chunk lifecycle

```
unloaded → requesting → decoding → ready → unloading → unloaded
               │            │
               ├────────────┴→ unloaded   (cancelled: the chunk went past the unload radius)
               └────────────┴→ failed → unloaded
```

`transition(from, to)` returns `to`, or throws if the move is not in the diagram.

- **Cancel.** A chunk that goes past the unload radius while loading is aborted through the
  `AbortSignal` and is `unloaded` at once, freeing its slot and its reserved memory. If the loader
  finishes the decode anyway, the result is unloaded straight away; it never becomes `ready`.
- **Failure.** If `request` or `decode` throws, the chunk becomes `failed`, `onError` is called
  and it is not retried until it goes past the unload radius and comes back.

## Which chunks load, and in what order

- Chunks within `loadRadius` (default 2) of the focus chunk are wanted. Chunks beyond
  `unloadRadius` (default 3) are unloaded. The band in between is hysteresis: a chunk there keeps
  its current state, so a focus moving back and forth across a border loads nothing twice.
- At most `maxConcurrent` loads (default 4) run at once. The rest wait, ordered by
  `loadPriority`: the distance from the chunk centre to where the focus will be in 2 seconds.
  At 70 m/s that point is 140 m ahead, so chunks ahead load well before the ones behind; at rest
  it is plain distance. The chunk under the focus always goes first.

```ts
import { loadPriority } from '@ceiba/streaming'

const car = { x: 70, z: 0 }
loadPriority({ x: 256, z: 0 }, { x: 0, z: 0 }, car) // 116, ahead: loads first
loadPriority({ x: -256, z: 0 }, { x: 0, z: 0 }, car) // 396, behind
```

## Memory budgets

Two budgets, `gpuBudget` and `ramBudget`, in bytes. Both always apply.

- A load reserves the manifest estimate before it starts, and the measured sizes returned by
  `decode` replace the estimate once the chunk is ready. Memory therefore never exceeds a budget
  as long as the estimates are not below the measured sizes.
- To make room, the streamer evicts `ready` chunks **outside the load radius**, least recently
  used first (a chunk is "used" on every update in which it is inside the load radius).
- Chunks inside the load radius are never evicted. If they alone do not fit, the lowest-priority
  ones simply stay unloaded and `overBudget` is `true` in the result of `update()` and in
  `snapshot()`. Nothing is loaded and unloaded in a loop. The same flag is raised when measured
  sizes turn out larger than estimated and nothing evictable is left.
- The bytes of a chunk in `unloading` count until `loader.unload` settles.

## World manifest

The JSON the asset pipeline will generate. `validateManifest(data)` checks parsed JSON and
returns it typed, or throws naming the first problem.

```ts
import type { WorldManifest } from '@ceiba/streaming'

const manifest: WorldManifest = {
  version: 1,
  chunkSize: 256, // metres
  chunks: [
    {
      cx: 0,
      cz: 0,
      url: 'chunks/0_0.glb',
      hash: '9f2c1ab4', // content hash, for cache versioning
      gpuBytes: 12_000_000, // estimates, reserved against the budgets
      ramBytes: 3_000_000,
      // optional low-detail version, same fields
      lod: { url: 'chunks/0_0.lod.glb', hash: '77aa01c2', gpuBytes: 400_000, ramBytes: 100_000 },
    },
  ],
}
```

A chunk that is not listed does not exist and is never requested. A streamer only loads
the chunk's own asset. For a low-detail ring in the distance, run a second streamer over
`lodManifest(manifest)` (the same world with each chunk replaced by its `lod`) with larger radii
and its own budgets, and hide a chunk's low detail while its full detail is `ready`. That is what
`streamingPlugin` of `@ceiba/babylon` does with its `lod` option.

## Debug view

```ts
import { type ChunkLoader, createStreamer, type WorldManifest } from '@ceiba/streaming'

declare const manifest: WorldManifest
declare const loader: ChunkLoader<object>

const streamer = createStreamer({
  manifest,
  loader,
  gpuBudget: 512e6,
  ramBudget: 256e6,
  onStateChange: (chunk, state, previous) => console.log(chunk.cx, chunk.cz, previous, '→', state),
  onError: (chunk, error) => console.error('chunk failed', chunk.url, error),
})

const { chunks, gpuBytes, ramBytes, overBudget } = streamer.snapshot()
for (const { cx, cz, state } of chunks) console.log(cx, cz, state) // unloaded chunks are not listed
console.log(gpuBytes, ramBytes, overBudget)
```

## API

### `createStreamer(options)`

| Option | Default | |
| --- | --- | --- |
| `manifest` | — | The `WorldManifest` |
| `loader` | — | The `ChunkLoader` |
| `gpuBudget`, `ramBudget` | — | Bytes. Pass `Infinity` for no limit |
| `loadRadius` | `2` | Chunks this close to the focus are loaded |
| `unloadRadius` | `3` | Chunks further than this are unloaded. Must be greater than `loadRadius` |
| `maxConcurrent` | `4` | Loads in `requesting` or `decoding` at once |
| `shiftThreshold` | `2` | Chunks the focus may be from the origin before it shifts |
| `origin` | `{ cx: 0, cz: 0 }` | Starting origin chunk |
| `onStateChange(chunk, state, previous)` | — | Every state change, synchronously |
| `onError(chunk, error)` | — | A load or an unload threw |

### Streamer

| Member | |
| --- | --- |
| `update({ position, velocity })` | Scene metres relative to `origin`, and m/s. Returns `{ originShift, overBudget }` |
| `origin` | The current origin chunk |
| `snapshot()` | `{ gpuBytes, ramBytes, overBudget, chunks }`, a copy for debug tools |
| `dispose()` | Cancels every load and unloads every chunk. Resolves when the unloads settle |

Loads start only inside `update()`: a finished load frees its slot, and the next one starts on the
following update.

### `ChunkLoader<H, D>`

| Method | |
| --- | --- |
| `request(chunk, signal)` | Fetches the data of a `ManifestChunk`. Resolves to `D` |
| `decode(data, chunk, signal)` | Builds the chunk. Resolves to `{ gpuBytes, ramBytes, handle }` |
| `unload(handle)` | Frees it. May return a promise |

### Other exports

- Grid: `chunkKey`, `chunkDistance`, `chunksWithin`, `chunkToScene`, `sceneToChunk`, `shiftOrigin`.
- `transition(from, to)`, `loadPriority(chunkCenter, position, velocity, lookahead?)`,
  `validateManifest(data)`.
- Types: `ChunkId`, `Vec2`, `ChunkState`, `ManifestChunk`, `WorldManifest`, `ChunkLoader`,
  `LoadedChunk`, `Streamer`, `StreamerOptions`, `StreamerUpdate`, `StreamerSnapshot`,
  `ChunkSnapshot`.

## License

[MIT](LICENSE)
