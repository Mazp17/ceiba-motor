import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { RenderStats } from './overlay.ts'

/**
 * Returns the `renderStats` option of `debugPlugin` for a Babylon scene. Lives in its own entry point
 * (`@ceiba/debug/babylon`) because it is the only part of the package that runs Babylon code.
 *
 * Draw calls come from `SceneInstrumentation.drawCallsCounter`: Babylon only resets that counter every
 * frame while an instrumentation exists, so one is created here and lives as long as the scene.
 */
export function babylonStats(scene: Scene): () => RenderStats {
  const instrumentation = new SceneInstrumentation(scene)
  return () => ({
    drawCalls: instrumentation.drawCallsCounter.current,
    triangles: scene.getActiveIndices() / 3,
    activeMeshes: scene.getActiveMeshes().length,
  })
}
