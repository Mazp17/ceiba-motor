import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import { Scene } from '@babylonjs/core/scene.js'
import { expect, test } from 'vitest'
import { babylonStats } from '../src/babylon.ts'

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
