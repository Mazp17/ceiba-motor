# Roadmap

**Overall progress: 14%** (6 of 44 tasks done)

Progress is the share of completed tasks, counted equally. Tasks differ a lot in size, so
read it as a rough indicator, not as time remaining.

## Expected output

When the roadmap is complete, Ceiba is:

- **A set of npm packages** (`@ceiba/*`) that add open-world capabilities to a Babylon.js
  game: unbundled ESM, tree-shakable, typed, each installable on its own.
- **World streaming that holds up at speed.** A world several kilometres wide loads and
  unloads by chunks around the player, stays inside a fixed memory budget, and never drops
  the player through ground that has not loaded yet.
- **An offline asset pipeline** (CLI) that takes source glTF files and produces compressed
  chunks, LODs, KTX2 textures and one manifest per chunk.
- **A sandbox with five scenes**, each validating one part of the engine against a
  measurable pass criterion (see below).
- **Documentation** of the public API and one minimal example per package.

What Ceiba is not: a renderer, an editor, or a game. Rendering, audio and asset decoding
come from Babylon.js, and all game logic lives in the game that consumes the engine.

## Phases

| # | Phase | Progress | Output |
| --- | --- | --- | --- |
| 1 | Monorepo and core | 60% | `@ceiba/core`: fixed-step loop, phases, error isolation, events, clock, logger, plugins |
| 2 | Streaming | 0% | `@ceiba/streaming`: chunk grid, lifecycle, priority queue, memory budgets with LRU, hysteresis, persistent cache |
| 3 | Tools | 0% | Asset pipeline CLI and a headless smoke test |
| 4 | Debug | 0% | `@ceiba/debug`: performance overlay, chunk visualizer, physics wireframes |
| 5 | Physics, input and vehicle | 0% | `@ceiba/physics` and `@ceiba/input`: per-chunk colliders, capsule character, raycast vehicle, action mapping |
| 6 | Stress test and save | 0% | `@ceiba/save`, the remaining scenes and the performance targets |

Phases 3 and 4 run alongside phase 2: streaming needs a test world to load and a way to
see what the chunks are doing.

## Sandbox scenes and pass criteria

| Scene | Validates | Passes when |
| --- | --- | --- |
| 1. Material | Babylon setup: PBR, HDRI, shadows | A PBR object renders lit by an HDRI with cascaded shadows, on WebGPU and on the WebGL2 fallback |
| 2. Large empty world | Streaming, cache, memory budgets | A free camera flies across several kilometres and memory never exceeds the budget |
| 3. Character | Per-chunk physics, input | A capsule walks across chunk borders without falling through or stuttering |
| 4. Vehicle | Streaming worst case | A car crosses chunks at high speed and always has a collider under it |
| 5. Stress test | Instancing, recovery from sudden load | Thousands of instances, many lights and random teleports, and the engine returns to its frame-time target |

The frame-time target and the memory budgets are not set yet. They are fixed once the target
hardware is chosen, before phase 2 is closed.

## Open decisions

- **Entity model**: Babylon nodes plus core systems (proposed), or a lightweight ECS.
- **Floating origin**: depends on a spike combining Babylon's large-world support with Havok,
  at the start of phase 2.
