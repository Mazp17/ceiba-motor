# @ceiba/core

The base of the Ceiba engine: a fixed-step game loop, system
phases, error isolation, a typed event bus, a clock, a logger and plugins. No dependencies,
no rendering, no game logic.

> Early development. The API changes without notice and the package is not on npm yet.

## Quick start

```ts
import { createEngine } from '@ceiba/core'

const engine = createEngine({ canvas })

engine.addSystem({
  name: 'mover',
  phase: 'update',
  update({ dt }) {
    // dt is the fixed step, in seconds
  },
})

engine.start()
```

## Phases

Every frame runs the phases in this order. Within a phase, systems run by `order` (lower
first, default 0).

| Phase | Runs | `dt` |
| --- | --- | --- |
| `input` | Once per frame | Scaled frame time |
| `update` | Zero or more times per frame, on the fixed step | `fixedDt` |
| `physics` | After each `update`, on the fixed step | `fixedDt` |
| `lateUpdate` | Once per frame | Scaled frame time |
| `render` | Once per frame | Scaled frame time |

`update` and `physics` always advance by exactly `fixedDt`, so the simulation gives the same
result at any frame rate. The time left over that does not fill a whole step reaches
`lateUpdate` and `render` as `alpha`, a number from 0 to 1: draw at
`previous + (current - previous) * alpha` to keep motion smooth.

If a frame takes so long that more than `maxSubSteps` steps are owed (a background tab, a
long stall), the engine runs `maxSubSteps` and drops the rest instead of trying to catch up.

## Error isolation

A system whose `update` throws is disabled. The error is logged, `system:error` is emitted,
and every other system keeps running.

```ts
engine.events.on('system:error', ({ system, error }) => {
  showRetryButton(system, error)
})

engine.enableSystem('mover') // turn it back on
```

## Clock

```ts
engine.clock.paused = true // input, lateUpdate and render still run, with dt = 0
engine.clock.timeScale = 0.5 // slow motion
engine.clock.time // simulated seconds; advances only in fixed steps
```

## Events

`engine.events` is typed by the `EngineEvents` interface. A package adds its own events by
declaration merging:

```ts
declare module '@ceiba/core' {
  interface EngineEvents {
    'chunk:ready': { x: number; z: number }
  }
}

const off = engine.events.on('chunk:ready', ({ x, z }) => {})
engine.events.emit('chunk:ready', { x: 0, z: 0 })
off()
```

Handlers run synchronously, in subscription order. For a standalone bus use
`createEventBus<MyEvents>()`.

## Plugins

A plugin is how another package registers its systems. `install` may be async; await
`engine.use()` when it is.

```ts
import type { Plugin } from '@ceiba/core'

export function physicsPlugin(): Plugin {
  return {
    name: 'physics',
    async install(engine) {
      const world = await loadPhysics()
      engine.addSystem({ name: 'physics', phase: 'physics', update: ({ dt }) => world.step(dt) })
    },
  }
}

await engine.use(physicsPlugin())
```

## Headless use

`start()` needs `requestAnimationFrame`. In tests or in Node, drive the loop yourself with
`tick(nowMs)`. The first call only sets the starting time.

```ts
const engine = createEngine({ logLevel: 'silent' })
engine.tick(0)
engine.tick(16) // simulates 16 ms
```

## API

### `createEngine(options?)`

| Option | Default | |
| --- | --- | --- |
| `canvas` | — | Not used by the core; exposed as `engine.canvas` for plugins |
| `fixedDt` | `1 / 60` | Seconds per simulation step |
| `maxSubSteps` | `8` | Fixed steps allowed per frame before the backlog is dropped |
| `logLevel` | `'info'` | `'debug'`, `'info'`, `'warn'`, `'error'` or `'silent'` |

### Engine

| Member | |
| --- | --- |
| `addSystem(system)` | Registers a system. Throws if the name is taken |
| `removeSystem(name)` | Removes it, effective in the same frame. No-op if unknown |
| `enableSystem(name)` | Re-enables a system disabled by an error. No-op if unknown |
| `use(plugin)` | Calls `plugin.install(engine)` and returns its result |
| `start()` / `stop()` | Starts and stops the `requestAnimationFrame` loop |
| `tick(nowMs)` | Advances one frame |
| `events` | The engine's `EventBus<EngineEvents>` |
| `clock` | `{ timeScale, paused, time }` |
| `log` | `debug`, `info`, `warn`, `error`, filtered by `logLevel` |
| `canvas` | The canvas passed in the options, if any |

`addSystem` and `removeSystem` are safe to call from inside a system.

### Other exports

- `PHASES`: the phase names, in execution order.
- `createEventBus<E>()`: a standalone typed event bus.
- `createLogger(level?, sink?)`: a standalone logger; `sink` defaults to `console`.
- Types: `Engine`, `EngineOptions`, `EngineEvents`, `System`, `Plugin`, `Frame`, `Phase`,
  `EventBus`, `Logger`, `LogLevel`.

## License

[MIT](LICENSE)
