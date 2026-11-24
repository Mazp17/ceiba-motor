# @ceiba/debug

A debug overlay for the Ceiba engine: performance counters, streaming budgets with a top-down
chunk map, the lights of the scene, systems disabled by an error, and buttons for your own debug
actions. Plain DOM and
one 2D canvas, installed as a core plugin.

> Early development. The API changes without notice and the package is not on npm yet.
>
> The logic is unit-tested, but the overlay has **not been looked at in a browser yet**: the
> layout, colours, canvas drawing and light gizmos are unverified.

`@ceiba/core` is a peer dependency. `@ceiba/streaming` and `@babylonjs/core` are optional
peers: the overlay works without either, and only `@ceiba/debug/babylon` runs Babylon code.

## Quick start

```ts
import { createEngine } from '@ceiba/core'

const engine = createEngine()

// Only debug sessions download the package.
if (new URLSearchParams(location.search).has('debug')) {
  const { debugPlugin } = await import('@ceiba/debug')
  const debug = debugPlugin()
  engine.use(debug)
  debug.addAction('pause', () => {
    engine.clock.paused = !engine.clock.paused
  })
}

engine.start()
```

The overlay is shown when the URL has `?debug`, and the backquote key (the one left of `1`)
shows and hides it. Both are configurable:

```ts
import { debugPlugin } from '@ceiba/debug'

debugPlugin({ param: 'dev', toggleKey: 'F3' }) // ?dev, and KeyboardEvent.code 'F3'
```

Installed without the URL parameter (so the key can open it later), it stays hidden and costs
one boolean check in each of its two systems; its DOM is created the first time it is shown.

## Performance

Always shown: FPS, average and worst frame time over the last 120 frames, fixed steps per frame
(average and maximum since the last refresh), and the JS heap where the browser exposes
`performance.memory` (Chromium).

Frame time is the interval between two frames, measured in the `render` phase, so it includes
the wait for the next display refresh.

Render counters need a Babylon scene:

```ts
import type { Scene } from '@babylonjs/core/scene.js'
import { debugPlugin } from '@ceiba/debug'
import { babylonStats } from '@ceiba/debug/babylon'

declare const scene: Scene // babylon.scene from @ceiba/babylon

debugPlugin({ renderStats: babylonStats(scene) })
```

| Counter | Babylon API |
| --- | --- |
| Draw calls | `new SceneInstrumentation(scene).drawCallsCounter.current` |
| Triangles | `scene.getActiveIndices() / 3` |
| Active meshes | `scene.getActiveMeshes().length` |

Babylon only resets the draw call counter each frame while a `SceneInstrumentation` exists, which
is why `babylonStats` creates one. `renderStats` is any function returning
`{ drawCalls, triangles, activeMeshes }`, so another renderer can feed the panel too.

## Streaming

```ts
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import { debugPlugin } from '@ceiba/debug'
import type { Streamer, WorldManifest } from '@ceiba/streaming'

declare const streamer: Streamer
declare const manifest: WorldManifest
declare const player: TransformNode

debugPlugin({
  streaming: {
    streamer,
    chunkSize: manifest.chunkSize,
    gpuBudget: 512e6,
    ramBudget: 256e6,
    loadRadius: 2,
    unloadRadius: 3,
    focus: () => ({ x: player.position.x, z: player.position.z, heading: player.rotation.y }),
  },
})
```

The streamer does not expose its options, so pass the same budgets and radii you gave it.
`focus` returns what `streamer.update` receives: the scene position in metres relative to the
origin. `heading` is optional, in radians, 0 looking along +z and growing towards +x.

The panel shows GPU and RAM bytes used against their budgets (highlighted in red with
`OVER BUDGET` when the snapshot says so), the number of chunks per state, the focus and origin
chunks, and how many origin shifts happened and how long ago.

The map is centred on the focus chunk, +x to the right and +z up, and reaches one chunk past
the unload radius:

- One cell per chunk, coloured by state: requesting, decoding, ready, unloading, failed. Unloaded
  chunks are blank.
- The load radius is a solid outline and the unload radius a dashed one.
- The origin chunk has a magenta outline. For two seconds after an origin shift its cell is
  filled, and it jumps to the centre while every chunk stays where it was.
- A chunk that has been `requesting` or `decoding` for more than a second gets a thick white
  outline and is counted as `late`.
- The focus is a white dot with a line along its heading.

The legend stays below the map. A blank cell inside the load radius is either a chunk that is
not in the manifest or one whose load has not started: the snapshot does not tell them apart.

## Lights

Lighting is plain Babylon; this panel only shows the lights a scene has and lets you poke at
them, which matters once lights stream in and out with their chunks.

```ts
import type { Scene } from '@babylonjs/core/scene.js'
import { debugPlugin } from '@ceiba/debug'
import { babylonLights } from '@ceiba/debug/babylon'

declare const scene: Scene

debugPlugin({ lighting: babylonLights(scene) })
```

- Totals: lights, how many are enabled, and shadow generators.
- One row per light: an intensity field, a checkbox that enables or disables it, its name, its
  type (`hemispheric`, `directional`, `point`, `spot`; any other light shows its class name) and
  `shadows` when it has a shadow generator. Rows come and go with the lights.
- `light gizmos` shows Babylon's `LightGizmo` for every light, so its position and direction are
  visible in the 3D view. They render in their own utility layer, follow lights added and removed
  later, and are disposed when the box is unchecked or the plugin is disposed.
- `OVER LIGHT LIMIT: n meshes drop lights` when meshes are lit by more lights than their
  material renders.

That last one is the failure mode of an open world. A Babylon material renders at most
`maxSimultaneousLights` lights per mesh (4 by default) and silently drops the rest. Babylon does
not cull lights by distance or `range` either: every enabled light counts for every mesh, unless
its `includedOnlyMeshes`, `excludedMeshes` or layer masks say otherwise. So the fifth lamp to
stream in anywhere turns one off everywhere. Raise `maxSimultaneousLights` on the material (each
light costs shader work on every mesh), or scope lights with `includedOnlyMeshes`.

How it is counted: Babylon keeps `mesh.lightSources` up to date itself, so `babylonLights`
compares its length with the material's `maxSimultaneousLights` for each active mesh (the ones
drawn last frame). Limits of that check:

- Meshes that were not drawn (culled, or in a chunk not loaded) are not counted.
- A mesh without a material counts against 4, the limit of the scene's default material.
- A material without the property (`ShaderMaterial`, `MultiMaterial`) or with `disableLighting`
  is never counted. Sub-materials of a `MultiMaterial` are not inspected.
- The engine's own cap on simultaneous lights, when lower than the material's, is ignored.

`lighting` is any `LightingDebug`, so another renderer can feed the panel too.

## System errors

A system that throws is disabled by the core and listed in the overlay with its error and a
`re-enable` button, which calls `engine.enableSystem(name)`. Errors are collected while the
overlay is hidden.

## Actions

```ts
import { debugPlugin } from '@ceiba/debug'

declare function teleport(x: number, z: number): void

const debug = debugPlugin()
debug.addAction('teleport far', () => teleport(5000, 0))
debug.visible = true // show or hide from code
```

## Update rates

Text is rewritten 4 times per second, which is also how often `lighting.snapshot()` is called,
and the map is redrawn 10 times per second, which is also how often `streamer.snapshot()` is
called.

## API

### `debugPlugin(options?)`

| Option | Default | |
| --- | --- | --- |
| `param` | `'debug'` | URL query parameter that shows the overlay on install |
| `toggleKey` | `'Backquote'` | `KeyboardEvent.code` of the key that shows and hides it |
| `renderStats` | — | `() => RenderStats`, e.g. `babylonStats(scene)` |
| `streaming` | — | A `StreamingDebug`: `streamer`, `chunkSize`, `gpuBudget`, `ramBudget`, `loadRadius` (2), `unloadRadius` (3), `focus()` |
| `lighting` | — | A `LightingDebug`, e.g. `babylonLights(scene)`: `snapshot()`, `setEnabled(id, enabled)`, `setIntensity(id, intensity)`, `setGizmos(shown)` |

Returns a `DebugPlugin`: a core `Plugin` plus

| Member | |
| --- | --- |
| `visible` | Whether the overlay is shown. Assign to show or hide it |
| `addAction(name, run)` | Adds a button. Works before and after install |
| `dispose()` | Removes the systems, the listeners, the element and the light gizmos |

It registers two systems: `debug:steps` (`update`) and `debug:overlay` (`render`, order 1000,
after the scene is drawn). `install` throws if the plugin is already installed.

### `babylonStats(scene)` — `@ceiba/debug/babylon`

Returns the `renderStats` function for a Babylon scene.

### `babylonLights(scene)` — `@ceiba/debug/babylon`

Returns the `lighting` option for a Babylon scene. `snapshot()` returns
`{ lights, shadowGenerators, overLimit }`, each light being
`{ id, name, type, intensity, enabled, shadows }` with `id` its Babylon `uniqueId`.

### Types

`DebugOptions`, `DebugPlugin`, `LightInfo`, `LightingDebug`, `LightingSnapshot`, `RenderStats`,
`StreamingDebug`.

## License

[MIT](LICENSE)
