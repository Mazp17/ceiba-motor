import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js'
import { Scene } from '@babylonjs/core/scene.js'
import type { Engine, Plugin } from '@ceiba/core'
import { type Backend, browser, createBabylonEngine, type Factories } from './backend.ts'

export interface BabylonOptions {
  /** `'auto'` (default) uses WebGPU when the browser supports it. WebGL2 is the fallback if WebGPU fails. */
  backend?: 'auto' | Backend
}

/** The plugin, plus what it created. `scene`, `engine` and `backend` throw until `engine.use()` has resolved. */
export interface BabylonPlugin extends Plugin {
  readonly scene: Scene
  /** The Babylon engine, not the Ceiba one. */
  readonly engine: AbstractEngine
  /** The backend actually in use, after any fallback. */
  readonly backend: Backend
  /** Removes the render system and disposes the scene and the Babylon engine. The plugin can be installed again. */
  dispose(): void
}

/**
 * Creates the Babylon engine on `engine.canvas` and a scene, and renders the scene once per frame in the
 * `render` phase. Installing is async: `await engine.use(plugin)`.
 */
export function babylonPlugin(options: BabylonOptions = {}): BabylonPlugin {
  return createPlugin(options, browser)
}

// Not exported from the package: lets tests inject a NullEngine.
export function createPlugin(options: BabylonOptions, factories: Factories): BabylonPlugin {
  let state:
    | { core: Engine; engine: AbstractEngine; scene: Scene; backend: Backend; observer: ResizeObserver }
    | undefined
  const installed = () => {
    if (!state) throw new Error('@ceiba/babylon is not installed: await engine.use(plugin) first')
    return state
  }
  return {
    name: 'babylon',
    get scene() {
      return installed().scene
    },
    get engine() {
      return installed().engine
    },
    get backend() {
      return installed().backend
    },
    async install(core) {
      if (state) throw new Error('@ceiba/babylon is already installed')
      if (!core.canvas) throw new Error('@ceiba/babylon needs a canvas: createEngine({ canvas })')
      const { engine, backend } = await createBabylonEngine(
        core.canvas,
        options.backend ?? 'auto',
        core.log.warn,
        factories,
      )
      const scene = new Scene(engine)
      // Resized inside the frame, right before drawing: resizing a canvas clears it, and doing that
      // from the observer callback would show a blank frame.
      let resized = false
      const observer = new ResizeObserver(() => {
        resized = true
      })
      observer.observe(core.canvas)
      core.addSystem({
        name: 'babylon:render',
        phase: 'render',
        update() {
          if (resized) {
            resized = false
            engine.resize()
          }
          // scene.render() throws without a camera, which would disable this system for good.
          if (!scene.activeCamera && !scene.activeCameras?.length) return
          // What Babylon's runRenderLoop does around each frame: timing, and presenting on WebGPU.
          engine.beginFrame()
          scene.render()
          engine.endFrame()
        },
      })
      state = { core, engine, scene, backend, observer }
    },
    dispose() {
      if (!state) return
      state.core.removeSystem('babylon:render')
      state.observer.disconnect()
      state.scene.dispose()
      state.engine.dispose()
      state = undefined
    },
  }
}
