import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import { LightGizmo } from '@babylonjs/core/Gizmos/lightGizmo.js'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js'
import { PointLight } from '@babylonjs/core/Lights/pointLight.js'
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js'
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js'
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import { Scene } from '@babylonjs/core/scene.js'
import { expect, test, vi } from 'vitest'
import { babylonLights, babylonStats } from '../src/babylon.ts'

test('reads the counters of the last rendered frame', () => {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  new FreeCamera('camera', new Vector3(0, 0, -10), scene)
  CreateBox('box', {}, scene)
  const stats = babylonStats(scene)
  scene.render()
  // Babylon only counts indices for a mesh it actually draws, which NullEngine never does: triangles
  // stay 0 here, so that counter is only checked for its shape.
  expect(stats()).toEqual({ drawCalls: 0, triangles: 0, activeMeshes: 1 })

  // NullEngine draws nothing, so report draw calls by hand, as a real engine does while rendering.
  engine._reportDrawCall(3)
  expect(stats().drawCalls).toBe(3)
  // The instrumentation resets the counter every frame; without it the count would keep growing.
  scene.render()
  expect(stats().drawCalls).toBe(0)
})

function lit() {
  const scene = new Scene(new NullEngine())
  new FreeCamera('camera', new Vector3(0, 0, -10), scene)
  return { scene, lighting: babylonLights(scene) }
}

test('lights: describes each light and counts shadow generators', () => {
  const { scene, lighting } = lit()
  new HemisphericLight('sky', Vector3.Up(), scene)
  const sun = new DirectionalLight('sun', Vector3.Down(), scene)
  new PointLight('lamp', Vector3.Zero(), scene).intensity = 0.5
  new SpotLight('torch', Vector3.Zero(), Vector3.Forward(), 1, 2, scene).setEnabled(false)
  new ShadowGenerator(256, sun)
  const { lights, shadowGenerators } = lighting.snapshot()
  expect(lights.map(({ id, ...light }) => light)).toEqual([
    { name: 'sky', type: 'hemispheric', intensity: 1, enabled: true, shadows: false },
    { name: 'sun', type: 'directional', intensity: 1, enabled: true, shadows: true },
    { name: 'lamp', type: 'point', intensity: 0.5, enabled: true, shadows: false },
    { name: 'torch', type: 'spot', intensity: 1, enabled: false, shadows: false },
  ])
  expect(shadowGenerators).toBe(1)

  const lamp = lights[2]?.id ?? -1
  lighting.setEnabled(lamp, false)
  lighting.setIntensity(lamp, 3)
  expect(lighting.snapshot().lights[2]).toMatchObject({ intensity: 3, enabled: false })
  // A light that is gone is ignored.
  lighting.setIntensity(-1, 3)
  lighting.setEnabled(-1, true)
})

test('lights: counts the drawn meshes lit by more enabled lights than their material takes', () => {
  const { scene, lighting } = lit()
  CreateBox('default material', {}, scene)
  const roomy = new StandardMaterial('roomy', scene)
  roomy.maxSimultaneousLights = 8
  CreateBox('roomy', {}, scene).material = roomy
  const unlit = new StandardMaterial('unlit', scene)
  unlit.disableLighting = true
  CreateBox('unlit', {}, scene).material = unlit
  const lamps = [1, 2, 3, 4, 5].map((i) => new PointLight(`lamp ${i}`, Vector3.Zero(), scene))
  // Nothing was drawn yet.
  expect(lighting.snapshot().overLimit).toBe(0)
  scene.render()
  expect(lighting.snapshot().overLimit).toBe(1)
  // A disabled light does not count; one more than 8 puts the second mesh over too.
  lamps[0]?.setEnabled(false)
  expect(lighting.snapshot().overLimit).toBe(0)
  for (let i = 0; i < 5; i++) new PointLight('more', Vector3.Zero(), scene)
  expect(lighting.snapshot().overLimit).toBe(2)
  // The 5 that are left are still one too many for the default material.
  for (const lamp of lamps) lamp.dispose()
  expect(lighting.snapshot().overLimit).toBe(1)
})

test('lights: gizmos follow lights added and removed, and leave nothing behind', async () => {
  const { scene, lighting } = lit()
  const attached = vi.spyOn(LightGizmo.prototype, 'light', 'set')
  const disposed = vi.spyOn(LightGizmo.prototype, 'dispose')
  const sky = new HemisphericLight('sky', Vector3.Up(), scene)
  lighting.setGizmos(true)
  lighting.setGizmos(true)
  expect(attached).toHaveBeenCalledTimes(1)
  const lamp = new PointLight('lamp', new Vector3(1, 2, 3), scene)
  new SpotLight('torch', Vector3.Zero(), Vector3.Forward(), 1, 2, scene)
  // Gone before Babylon announces it, which it does on the next tick.
  new PointLight('brief', Vector3.Zero(), scene).dispose()
  await new Promise((resolve) => setTimeout(resolve))
  expect(attached.mock.calls.map(([light]) => light?.name)).toEqual(['sky', 'lamp', 'torch'])
  // The gizmos update in the utility layer, which renders with the scene.
  scene.render()
  lamp.dispose()
  expect(disposed).toHaveBeenCalledTimes(1)
  sky.dispose()
  lighting.setGizmos(false)
  expect(disposed).toHaveBeenCalledTimes(3)
  // Off: a new light gets no gizmo, and the gizmos never touched the scene itself.
  new PointLight('late', Vector3.Zero(), scene)
  await new Promise((resolve) => setTimeout(resolve))
  expect(attached).toHaveBeenCalledTimes(3)
  expect(scene.onNewLightAddedObservable.hasObservers()).toBe(false)
  expect(scene.onLightRemovedObservable.hasObservers()).toBe(false)
  expect(scene.meshes).toEqual([])
  expect(scene.lights).toHaveLength(2)
  vi.restoreAllMocks()
})
