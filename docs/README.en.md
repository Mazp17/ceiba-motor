# Ceiba

[Español](../README.md) · **English**

Open-world layer for browser games on top of [Babylon.js](https://www.babylonjs.com/): chunk-based world streaming, per-chunk physics and a core of isolated systems.

> Early development. The API changes without notice and no packages are published to npm yet.

## Packages

| Package | Status | What it does |
| --- | --- | --- |
| `@ceiba/core` | ready | Fixed-step loop, phases, error isolation, events, clock, logger, plugins |
| `@ceiba/streaming` | pending | Chunk grid, priority queue, memory budgets, LRU |
| `@ceiba/physics` | pending | Per-chunk colliders and vehicle on Havok |
| `@ceiba/input` | pending | Action mapping over keyboard, mouse and gamepad |
| `@ceiba/save` | pending | State to IndexedDB with schema versioning |
| `@ceiba/debug` | pending | Performance overlay and chunk visualizer |

## Usage

```ts
import { createEngine } from '@ceiba/core'

const engine = createEngine({ canvas })

engine.addSystem({
  name: 'mover',
  phase: 'update', // input | update | physics | lateUpdate | render
  update({ dt }) {
    // fixed-step simulation
  },
})

engine.start()
```

A system that throws is disabled, emits `system:error`, and the rest keep running.

## Development

Requires Node 24 and pnpm 12.

```sh
pnpm install
pnpm build
pnpm test
pnpm size
```

## Roadmap

Project status and expected output in [ROADMAP.md](../ROADMAP.md).

## License

[MIT](../LICENSE)

---

Made with ❤️ from Colombia
