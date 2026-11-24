import { LightGizmo } from '@babylonjs/core/Gizmos/lightGizmo.js'
import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation.js'
import type { Light } from '@babylonjs/core/Lights/light.js'
import { UtilityLayerRenderer } from '@babylonjs/core/Rendering/utilityLayerRenderer.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { LightingDebug, RenderStats } from './overlay.ts'

/**
 * Returns the `renderStats` option of `debugPlugin` for a Babylon scene. Lives in its own entry point
 * (`@ceiba/debug/babylon`) because it is the only part of the package, with `babylonLights`, that runs Babylon code.
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

/** A mesh without a material is drawn with the scene's default one, a StandardMaterial: 4 lights. */
const NO_MATERIAL = { maxSimultaneousLights: 4 }
/** Indexed by `Light.getTypeID()`. */
const LIGHT_TYPES = ['point', 'directional', 'spot', 'hemispheric']

/**
 * Returns the `lighting` option of `debugPlugin` for a Babylon scene.
 *
 * `overLimit` counts the active meshes (the ones Babylon drew last frame) whose `lightSources` outnumber
 * their material's `maxSimultaneousLights`. Babylon keeps `mesh.lightSources` in sync itself (enabled
 * lights that pass the include/exclude lists and layer masks, with no check of range or distance) and
 * binds only the first `maxSimultaneousLights` of them, so the count is exact and allocates nothing.
 */
export function babylonLights(scene: Scene): LightingDebug {
  const gizmos = new Map<Light, LightGizmo>()
  let layer: UtilityLayerRenderer | undefined
  const add = (light: Light) => {
    // Babylon announces a new light on the next tick: by then it may be gone, or the gizmos off.
    if (!layer || light.isDisposed() || gizmos.has(light)) return
    const gizmo = new LightGizmo(layer)
    gizmo.light = light
    gizmos.set(light, gizmo)
  }
  const remove = (light: Light) => {
    gizmos.get(light)?.dispose()
    gizmos.delete(light)
  }
  return {
    snapshot() {
      let shadowGenerators = 0
      const lights = scene.lights.map((light) => {
        const generators = light.getShadowGenerators()?.size ?? 0
        shadowGenerators += generators
        return {
          id: light.uniqueId,
          name: light.name,
          type: LIGHT_TYPES[light.getTypeID()] ?? light.getClassName(),
          intensity: light.intensity,
          enabled: light.isEnabled(),
          shadows: generators > 0,
        }
      })
      let overLimit = 0
      const active = scene.getActiveMeshes()
      for (let i = 0; i < active.length; i++) {
        const mesh = active.data[i]
        // shortcut: a MultiMaterial or a material without the property (ShaderMaterial) is never counted,
        // and the engine's own cap on simultaneous lights is ignored; check sub-materials if that hides a case.
        const material = (mesh?.material ?? NO_MATERIAL) as {
          maxSimultaneousLights?: number
          disableLighting?: boolean
        }
        const limit = material.disableLighting ? Infinity : (material.maxSimultaneousLights ?? Infinity)
        if (mesh && mesh.lightSources.length > limit) overLimit++
      }
      return { lights, shadowGenerators, overLimit }
    },
    setEnabled(id, enabled) {
      scene.getLightByUniqueId(id)?.setEnabled(enabled)
    },
    setIntensity(id, intensity) {
      const light = scene.getLightByUniqueId(id)
      if (light) light.intensity = intensity
    },
    setGizmos(shown) {
      if (shown === !!layer) return
      if (shown) {
        // Its own layer, without pointer handling: the default one binds to the last created scene and picks.
        layer = new UtilityLayerRenderer(scene, false)
        scene.lights.forEach(add)
        scene.onNewLightAddedObservable.add(add)
        scene.onLightRemovedObservable.add(remove)
      } else {
        scene.onNewLightAddedObservable.removeCallback(add)
        scene.onLightRemovedObservable.removeCallback(remove)
        for (const gizmo of gizmos.values()) gizmo.dispose()
        gizmos.clear()
        layer?.dispose()
        layer = undefined
      }
    },
  }
}
