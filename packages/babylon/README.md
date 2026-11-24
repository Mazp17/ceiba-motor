# @ceiba/babylon

Connects [Babylon.js](https://www.babylonjs.com/) to the Ceiba engine loop: creates the Babylon
engine (WebGPU or WebGL2) and a scene on the engine's canvas, and renders the scene once per
frame from the `render` phase.

> Early development. The API changes without notice and the package is not on npm yet.

`@babylonjs/core` and `@ceiba/core` are peer dependencies: the game installs them and decides
the Babylon version.

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
earlier throws. Pass the scene on to whatever needs it:

```ts
await engine.use(streamingPlugin({ scene: babylon.scene }))
```

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

### Types

`BabylonPlugin`, `BabylonOptions`, `Backend`.

## License

[MIT](LICENSE)
