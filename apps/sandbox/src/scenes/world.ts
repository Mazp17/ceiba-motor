// The generated test world (16 km of chunks), streamed around a fly camera, with the debug overlay on.
// Click to capture the mouse, WASD to move, Q/E down/up, Esc to release, ` to hide the overlay.
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js'
import { Color4 } from '@babylonjs/core/Maths/math.color.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { streamingPlugin } from '@ceiba/babylon'
import type { SandboxScene } from '../scenes.ts'

const MANIFEST_URL = '/world/manifest.json'
const LOAD_RADIUS = 3
const UNLOAD_RADIUS = 5
// The worst 7x7 window of the default world needs about 1.5 MB of GPU and 3 MB of RAM by the manifest
// estimates, which is what a load reserves. These fit that with little to spare, so the ring between
// the load and unload radius gets evicted in dense areas.
const GPU_BUDGET = 1.8e6
const RAM_BUDGET = 3.5e6

export default {
  async setup({ engine, babylon, canvas }) {
    const { scene } = babylon
    const response = await fetch(MANIFEST_URL)
    if (!response.ok) throw new Error(`no world at ${MANIFEST_URL}: run "pnpm world" and reload`)
    const { chunkSize, chunks } = (await response.json()) as { chunkSize: number; chunks: { cx: number; cz: number }[] }
    // World extent in chunks: [min, max) on each axis.
    const min = { x: Math.min(...chunks.map((c) => c.cx)), z: Math.min(...chunks.map((c) => c.cz)) }
    const max = { x: Math.max(...chunks.map((c) => c.cx)) + 1, z: Math.max(...chunks.map((c) => c.cz)) + 1 }

    scene.clearColor = new Color4(0.55, 0.7, 0.9, 1)
    new HemisphericLight('light', new Vector3(0.3, 1, 0.2), scene)

    const camera = new FreeCamera('camera', new Vector3(chunkSize / 2, 40, chunkSize / 2), scene)
    camera.setTarget(new Vector3(chunkSize, 20, chunkSize))
    camera.minZ = 0.5
    camera.maxZ = chunkSize * (UNLOAD_RADIUS + 1)
    camera.speed = 8
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

    const streaming = streamingPlugin({
      scene,
      manifestUrl: MANIFEST_URL,
      focus: () => camera.position,
      gpuBudget: GPU_BUDGET,
      ramBudget: RAM_BUDGET,
      loadRadius: LOAD_RADIUS,
      unloadRadius: UNLOAD_RADIUS,
    })
    await engine.use(streaming)
    // The plugin moves the chunks; the camera is ours to move.
    engine.events.on('streaming:originShift', ({ delta }) => {
      camera.position.x += delta.x
      camera.position.z += delta.z
    })

    // Keeps the camera over the world: past the edge there is nothing to stream and it looks like a stall.
    engine.addSystem({
      name: 'world:bounds',
      phase: 'update',
      update() {
        const { origin } = streaming.streamer
        const { position } = camera
        position.x = Math.min(Math.max(position.x, (min.x - origin.cx) * chunkSize), (max.x - origin.cx) * chunkSize)
        position.z = Math.min(Math.max(position.z, (min.z - origin.cz) * chunkSize), (max.z - origin.cz) * chunkSize)
      },
    })

    const [{ debugPlugin }, { babylonStats }] = await Promise.all([
      import('@ceiba/debug'),
      import('@ceiba/debug/babylon'),
    ])
    const debug = debugPlugin({
      renderStats: babylonStats(scene),
      streaming: {
        streamer: streaming.streamer,
        chunkSize,
        gpuBudget: GPU_BUDGET,
        ramBudget: RAM_BUDGET,
        loadRadius: LOAD_RADIUS,
        unloadRadius: UNLOAD_RADIUS,
        focus: () => ({ x: camera.position.x, z: camera.position.z, heading: camera.rotation.y }),
      },
    })
    engine.use(debug)
    debug.visible = true
    debug.addAction('faster', () => {
      camera.speed *= 2
    })
    debug.addAction('slower', () => {
      camera.speed /= 2
    })
    // Anywhere in the world: the recovery-from-a-jump case of the stress test.
    debug.addAction('teleport', () => {
      const { origin } = streaming.streamer
      camera.position.x = (min.x + Math.random() * (max.x - min.x) - origin.cx) * chunkSize
      camera.position.z = (min.z + Math.random() * (max.z - min.z) - origin.cz) * chunkSize
    })

    return () => {
      canvas.removeEventListener('click', lock)
      document.exitPointerLock()
      debug.dispose()
      void streaming.dispose()
    }
  },
} satisfies SandboxScene
