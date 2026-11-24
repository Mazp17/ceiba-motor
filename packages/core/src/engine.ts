import { createEventBus, type EventBus } from './events.ts'
import { createLogger, type Logger, type LogLevel } from './logger.ts'

/** Execution order within a frame. `update` and `physics` run on the fixed step; the rest once per frame. */
export const PHASES = ['input', 'update', 'physics', 'lateUpdate', 'render'] as const
export type Phase = (typeof PHASES)[number]

/** What a system receives on every update. */
export interface Frame {
  /** Seconds. The fixed step in `update`/`physics`, the scaled frame time elsewhere. */
  dt: number
  /** Fraction of a fixed step not yet simulated, for render interpolation. 0 in fixed phases. */
  alpha: number
}

/** A unit of per-frame work. If `update` throws, the system is disabled and `system:error` is emitted. */
export interface System {
  /** Unique within the engine; used to remove or re-enable the system. */
  name: string
  phase: Phase
  /** Lower runs first within the phase. Default 0. */
  order?: number
  update(frame: Frame): void
}

/** How a package registers itself: `install` adds its systems and event handlers to the engine. */
export interface Plugin {
  name: string
  /** May be async, e.g. to load WASM before registering systems. */
  install(engine: Engine): void | Promise<void>
}

/** Plugins add their events here by declaration merging. */
export interface EngineEvents {
  /** A system threw and was disabled. `enableSystem` turns it back on. */
  'system:error': { system: string; error: unknown }
}

export interface EngineOptions {
  /** Not used by the core; exposed as `engine.canvas` for plugins that render or read input. */
  canvas?: HTMLCanvasElement
  /** Seconds per simulation step. Default 1/60. */
  fixedDt?: number
  /** Fixed steps allowed per frame before the backlog is dropped. Default 8. */
  maxSubSteps?: number
  /** Default `'info'`. */
  logLevel?: LogLevel
}

export interface Engine {
  readonly canvas: HTMLCanvasElement | undefined
  readonly events: EventBus<EngineEvents>
  readonly log: Logger
  /** `time` is simulated seconds; it only advances in fixed steps. */
  readonly clock: { timeScale: number; paused: boolean; time: number }
  /** Await the result if the plugin installs asynchronously. */
  use(plugin: Plugin): void | Promise<void>
  /** Throws if a system with the same name is registered. Safe to call from inside a system. */
  addSystem(system: System): void
  /** No-op if no system has that name. Safe to call from inside a system. */
  removeSystem(name: string): void
  /** Turns a system disabled by an error back on. No-op if it is unknown or already running. */
  enableSystem(name: string): void
  /** Advances one frame. `start()` calls it from requestAnimationFrame; call it directly when headless. */
  tick(nowMs: number): void
  /** Starts the requestAnimationFrame loop. No-op if already running. */
  start(): void
  /** Stops the loop. The time spent stopped is not simulated when `start()` is called again. */
  stop(): void
}

/** Creates an engine with no systems. Synchronous; nothing runs until `start()` or `tick()`. */
export function createEngine(options: EngineOptions = {}): Engine {
  const { fixedDt = 1 / 60, maxSubSteps = 8 } = options
  const log = createLogger(options.logLevel)
  const events = createEventBus<EngineEvents>()
  const clock = { timeScale: 1, paused: false, time: 0 }
  // Replaced, never mutated: a tick in progress keeps iterating the array it started with.
  let systems: System[] = []
  const disabled = new WeakSet<System>()
  const fixed: Frame = { dt: fixedDt, alpha: 0 }
  let last: number | undefined
  let acc = 0
  let raf = 0

  function run(phase: Phase, frame: Frame) {
    for (const system of systems) {
      if (system.phase !== phase || disabled.has(system)) continue
      try {
        system.update(frame)
      } catch (error) {
        disabled.add(system)
        log.error(`system "${system.name}" disabled after error`, error)
        events.emit('system:error', { system: system.name, error })
      }
    }
  }

  function tick(nowMs: number) {
    const dt = clock.paused || last === undefined ? 0 : ((nowMs - last) / 1000) * clock.timeScale
    last = nowMs
    run('input', { dt, alpha: 0 })
    acc += dt
    for (let i = 0; acc >= fixedDt && i < maxSubSteps; i++) {
      run('update', fixed)
      run('physics', fixed)
      acc -= fixedDt
      clock.time += fixedDt
    }
    if (acc >= fixedDt) acc = 0 // drop the backlog after a stall instead of spiralling
    const frame = { dt, alpha: acc / fixedDt }
    run('lateUpdate', frame)
    run('render', frame)
  }

  const engine: Engine = {
    canvas: options.canvas,
    events,
    log,
    clock,
    tick,
    use: (plugin) => plugin.install(engine),
    addSystem(system) {
      if (systems.some((s) => s.name === system.name)) throw new Error(`system "${system.name}" already registered`)
      disabled.delete(system)
      systems = [...systems, system].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    },
    removeSystem(name) {
      const system = systems.find((s) => s.name === name)
      if (!system) return
      disabled.add(system) // a tick in progress still holds it in its array
      systems = systems.filter((s) => s !== system)
    },
    enableSystem(name) {
      const system = systems.find((s) => s.name === name)
      if (system) disabled.delete(system)
    },
    start() {
      if (raf) return
      const loop = (now: number) => {
        raf = requestAnimationFrame(loop)
        tick(now)
      }
      raf = requestAnimationFrame(loop)
    },
    stop() {
      cancelAnimationFrame(raf)
      raf = 0
      last = undefined
    },
  }
  return engine
}
