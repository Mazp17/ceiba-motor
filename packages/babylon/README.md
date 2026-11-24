# @ceiba/babylon

Connects [Babylon.js](https://www.babylonjs.com/) to the Ceiba engine loop: creates the Babylon
engine (WebGPU or WebGL2) and a scene on the engine's canvas, and renders the scene once per
frame from the `render` phase. It also holds the streaming adapter: `streamingPlugin` loads the
chunks that `@ceiba/streaming` asks for into the scene.

> Early development. The API changes without notice and the package is not on npm yet.

`@babylonjs/core`, `@babylonjs/loaders`, `@ceiba/core` and `@ceiba/streaming` are peer
dependencies: the game installs them and decides the Babylon version. A game that only imports
`babylonPlugin` installs all four but bundles neither the glTF loader nor the streaming code.

## Quick start

```ts
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { babylonPlugin } from '@ceiba/babylon'
import { createEngine } from '@ceiba/core'

const canvas = document.querySelector('canvas') as HTMLCanvasElement
const engine = createEngine({ canvas })
const babylon = babylonPlugin()
await engine.use(babylon) // async: it may have to load and initialise WebGPU

new FreeCamera('camera', new Vector3(0, 2, -10), babylon.scene)
engine.start()
```

Nothing is drawn until the scene has a camera.

`scene`, `engine` and `backend` are available once `engine.use()` has resolved; reading them
earlier throws. Pass the scene on to whatever needs it, like `streamingPlugin` below.

## Streaming a world

```ts
import { streamingPlugin } from '@ceiba/babylon'

const camera = new FreeCamera('camera', new Vector3(128, 30, 128), babylon.scene)
const streaming = streamingPlugin({
  scene: babylon.scene,
  manifestUrl: '/world/manifest.json',
  focus: () => camera.position,
  gpuBudget: 512e6,
  ramBudget: 256e6,
})
await engine.use(streaming) // async: it fetches and validates the manifest

// The origin moved: shift everything you own in the scene, the focus included.
engine.events.on('streaming:originShift', ({ delta }) => {
  camera.position.x += delta.x
  camera.position.z += delta.z
})
```

The manifest is the `WorldManifest` of `@ceiba/streaming`. Each chunk `url` is resolved against
the manifest's own URL and must be a `.glb` whose content, once loaded, spans x and z in
`[0, chunkSize]` with the chunk's minimum corner at its origin. Every chunk hangs from one
`TransformNode` named `chunk:<cx>,<cz>`, placed at `chunkToScene(chunk, origin, chunkSize)`; the
glTF loader's own `__root__` (its handedness conversion) is kept below it.

Every other option (`loadRadius`, `unloadRadius`, `maxConcurrent`, `shiftThreshold`, `origin`) is
passed to `createStreamer`.

### Low detail in the distance

```ts
streamingPlugin({
  // ...
  loadRadius: 3,
  unloadRadius: 5,
  lod: { loadRadius: 8, unloadRadius: 10, gpuBudget: 64e6, ramBudget: 32e6 },
})
```

With `lod`, every chunk that has a `lod` asset in the manifest is also streamed in that wider ring,
under a root named `lod:<cx>,<cz>`. A chunk's low detail is hidden while its full detail is in the
scene and shown otherwise, so a chunk does not pop in from nothing and the distance is not empty.
It stays loaded underneath, which is what makes the swap instant: budget it for the whole ring.
The swap is a hard cut, there is no cross-fade. `streamer` and the `streaming:*` events report
full-detail chunks only.

### Origin shifts

The plugin registers one system, `streaming`, at the start of the `physics` phase (order -100):
after the game moved the focus in `update`, before the physics step of that tick. Give a physics
system a higher order. A streamer update only happens on fixed steps, so nothing loads while the
clock is paused.

When the focus is more than `shiftThreshold` chunks from the origin, the plugin moves every
chunk root and emits `streaming:originShift` with the `delta` in metres and the new `origin`
chunk. **The plugin does not move the focus**: it only gets a position from `focus()`, and what
is behind it (a camera, a node, a physics body that must be teleported) belongs to the game or
to another package. Handlers run synchronously, so add `delta` right there to everything that
holds a scene position: the focus, cameras and their targets, physics bodies, and cached values
such as the previous position used for render interpolation. If the focus is not shifted, the
next update reads it in the new frame and the origin shifts again.

### Events

| Event | Payload | |
| --- | --- | --- |
| `streaming:originShift` | `{ delta, origin }` | See above |
| `streaming:chunkState` | `{ chunk, state, previous }` | Every state change of a chunk |
| `streaming:overBudget` | `{ overBudget }` | When it changes: the wanted chunks do not fit the budgets |

A chunk that fails to load is logged through `engine.log.error` and shows up as `failed`.

### Cache

Chunk downloads are kept in the Cache API (cache `ceiba-chunks`), one entry per chunk URL tagged
with the manifest `hash`. A chunk whose hash changed is downloaded again and overwrites its
entry. Without the Cache API (insecure context) or when it throws, chunks are simply fetched.

### Memory figures

WebGL and WebGPU do not report memory, so the sizes given to the streamer once a chunk is decoded
are estimates. GPU: vertex attributes and indices as uploaded, plus every texture counted as
uncompressed RGBA8 with mipmaps (too high for compressed textures). RAM: the size of the `.glb`,
which stays alive because Babylon keeps the geometry arrays and they are views into it.

### glTF loader

Only the glTF 2.0 loader is registered, with no extensions. A world that uses one (Draco,
meshopt, KTX2 textures) registers it itself:

```ts
import { registerBuiltInGLTFExtensions } from '@babylonjs/loaders/glTF/2.0/Extensions/dynamic.js'

registerBuiltInGLTFExtensions() // each extension is downloaded only when a chunk uses it
```

### Teardown

```ts
await streaming.dispose()
```

Removes the system, cancels every load and unloads every chunk. Call it before
`babylon.dispose()`.

## Backend

```ts
babylonPlugin({ backend: 'auto' }) // default: WebGPU if the browser has an adapter, else WebGL2
babylonPlugin({ backend: 'webgl2' })
babylonPlugin({ backend: 'webgpu' }) // tried without asking the browser first
```

If WebGPU fails to initialise, a warning is logged and the plugin falls back to WebGL2, also
when `'webgpu'` was requested. `babylon.backend` tells which one is running.

The WebGPU engine is loaded with a dynamic `import()`, so a WebGL2 session never downloads it.

## The frame

The core loop drives rendering; Babylon's `runRenderLoop` is not used. The plugin registers
one system, `babylon:render`, in the `render` phase (order 0). Each frame it applies a pending
canvas resize, then runs `beginFrame()`, `scene.render()`, `endFrame()`.

Write positions in `update` (fixed step) and the interpolated transform in `lateUpdate`, which
runs before the draw:

```ts
let previous = 0
let current = 0
engine.addSystem({
  name: 'move',
  phase: 'update',
  update({ dt }) {
    previous = current
    current += 2 * dt
  },
})
engine.addSystem({
  name: 'draw',
  phase: 'lateUpdate',
  update({ alpha }) {
    mesh.position.x = previous + (current - previous) * alpha
  },
})
```

What Babylon updates by itself inside `scene.render()` (animations, particles, camera inputs)
runs on Babylon's own frame time, not on the fixed step, and ignores `engine.clock`.

The canvas is rendered at CSS-pixel resolution, as Babylon does by default. For native
resolution on high-DPI screens:

```ts
babylon.engine.setHardwareScalingLevel(1 / devicePixelRatio)
```

## Teardown

```ts
babylon.dispose()
```

Removes the render system, stops watching the canvas and disposes the scene and the Babylon
engine. The same plugin object can be installed again, on the same canvas if the backend does
not change (a canvas keeps the kind of context it was first given).

## Importing Babylon

Use deep imports with the `.js` suffix, never the package root:

```ts
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
```

`@babylonjs/core` has no `exports` map, so Node (and Vitest) only resolve the path with the
suffix; bundlers accept both. The root import pulls in the whole library and defeats
tree-shaking.

## API

### `babylonPlugin(options?)`

| Option | Default | |
| --- | --- | --- |
| `backend` | `'auto'` | `'auto'`, `'webgpu'` or `'webgl2'` |

Returns a `BabylonPlugin`: a core `Plugin` plus

| Member | |
| --- | --- |
| `scene` | The Babylon `Scene` |
| `engine` | The Babylon engine (`AbstractEngine`), not the Ceiba one |
| `backend` | `'webgpu'` or `'webgl2'`: the one in use, after any fallback |
| `dispose()` | Tears everything down. No-op if not installed |

`install` throws if the engine was created without a `canvas`, or if the plugin is already
installed.

### `streamingPlugin(options)`

| Option | Default | |
| --- | --- | --- |
| `scene` | — | The scene chunks are added to |
| `manifestUrl` | — | URL of the world manifest JSON |
| `focus()` | — | Scene position (`{ x, z }`) the world streams around. Read every fixed step |
| `velocity()` | derived from `focus()` | Speed of the focus in m/s, for load priority |
| `meshopt` | none | Decoder for Meshopt-compressed chunks: `MeshoptDecoder` from `meshoptimizer/decoder` |
| `gpuBudget`, `ramBudget` | — | Bytes. Passed to `createStreamer`, like the remaining options |

Returns a `StreamingPlugin`: a core `Plugin` plus

| Member | |
| --- | --- |
| `streamer` | The `Streamer`, for debug tools: `snapshot()`, `origin`. Throws until installed |
| `dispose()` | Unloads everything. Returns a promise. No-op if not installed |

`install` rejects if the manifest cannot be fetched or is invalid, or if the plugin is already
installed.

Chunks written by the asset pipeline (`tools/pipeline`) are Meshopt-compressed. Babylon would fetch
its decoder from the Babylon CDN; this package never does. Install `meshoptimizer` in the game and
pass its decoder, which embeds the WebAssembly and is bundled with the game:

```ts
import { MeshoptDecoder } from 'meshoptimizer/decoder'

streamingPlugin({ scene, manifestUrl, focus, gpuBudget, ramBudget, meshopt: MeshoptDecoder })
```

Quantized vertices (`KHR_mesh_quantization`) and WebP textures (`EXT_texture_webp`) load with no
setup. KTX2 textures (`KHR_texture_basisu`) are not wired up yet.

### Types

`BabylonPlugin`, `BabylonOptions`, `Backend`, `StreamingPlugin`, `StreamingOptions`, `MeshoptDecoder`.

## License

[MIT](LICENSE)
