// Ground, boxes, a light and a fly camera (click to capture the mouse, WASD to move, Q/E down/up, Esc to release).
// Two boxes slide side by side on the same fixed-step simulation: the green one is drawn interpolated
// with `alpha`, the red one at its last simulated position, so it visibly jumps 10 times a second.
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { SandboxScene } from '../scenes.ts'

export default {
  fixedDt: 1 / 10, // far below the display rate on purpose, so the missing interpolation is obvious
  setup({ engine, babylon, canvas }) {
    const { scene } = babylon
    const paint = (mesh: Mesh, r: number, g: number, b: number) => {
      const material = new StandardMaterial(mesh.name, scene)
      material.diffuseColor = new Color3(r, g, b)
      mesh.material = material
      return mesh
    }

    new HemisphericLight('light', new Vector3(0.3, 1, 0.2), scene)
    paint(CreateGround('ground', { width: 40, height: 40 }, scene), 0.35, 0.4, 0.35)
    for (const [x, z, height] of [
      [-6, 6, 1],
      [0, 8, 3],
      [6, 6, 2],
    ] as const) {
      paint(CreateBox('box', { width: 1.5, depth: 1.5, height }, scene), 0.3, 0.5, 0.9).position.set(x, height / 2, z)
    }
    const smooth = paint(CreateBox('smooth', { size: 1 }, scene), 0.2, 0.8, 0.3)
    const stepped = paint(CreateBox('stepped', { size: 1 }, scene), 0.9, 0.25, 0.2)
    smooth.position.set(0, 0.5, 0)
    stepped.position.set(0, 0.5, 2)

    const camera = new FreeCamera('camera', new Vector3(0, 3, -12), scene)
    camera.setTarget(new Vector3(0, 1, 2))
    camera.minZ = 0.1
    camera.speed = 0.5
    camera.keysUp = [87] // W
    camera.keysDown = [83] // S
    camera.keysLeft = [65] // A
    camera.keysRight = [68] // D
    camera.keysUpward = [69] // E
    camera.keysDownward = [81] // Q
    camera.attachControl()
    const lock = async () => {
      try {
        await canvas.requestPointerLock()
      } catch {
        // The browser refuses to lock again right after Esc; the next click works.
      }
    }
    canvas.addEventListener('click', lock)

    let time = 0
    let previous = 0
    let current = 0
    engine.addSystem({
      name: 'hello:slide',
      phase: 'update',
      update({ dt }) {
        time += dt
        previous = current
        current = Math.sin(time * 1.5) * 5
      },
    })
    engine.addSystem({
      name: 'hello:draw',
      phase: 'lateUpdate',
      update({ alpha }) {
        smooth.position.x = previous + (current - previous) * alpha
        stepped.position.x = current
      },
    })

    return () => {
      canvas.removeEventListener('click', lock)
      document.exitPointerLock()
    }
  },
} satisfies SandboxScene
