// ?scene=<name> picks the scene (default hello); ?backend=webgpu|webgl2 forces the backend (default auto).
import { babylonPlugin } from '@ceiba/babylon'
import { createEngine } from '@ceiba/core'
import { scenes } from './scenes.ts'

const canvas = document.querySelector('canvas') as HTMLCanvasElement
const status = document.querySelector('#status') as HTMLElement
const nav = document.querySelector('nav') as HTMLElement
const LABELS = { webgpu: 'WebGPU', webgl2: 'WebGL2' }

let unload = () => {}

async function load() {
  unload()
  unload = () => {}
  const params = new URLSearchParams(location.search)
  const name = params.get('scene') ?? 'hello'
  const loader = scenes[name]
  if (!loader) throw new Error(`unknown scene "${name}"`)
  status.textContent = `loading ${name}`
  const { default: scene } = await loader()

  const engine = createEngine({ canvas, fixedDt: scene.fixedDt })
  const babylon = babylonPlugin({ backend: (params.get('backend') ?? 'auto') as 'auto' | 'webgpu' | 'webgl2' })
  let teardown = () => {}
  unload = () => {
    engine.stop()
    teardown()
    babylon.dispose()
  }
  await engine.use(babylon)
  babylon.engine.setHardwareScalingLevel(1 / devicePixelRatio) // native resolution on high-DPI screens
  teardown = await scene.setup({ engine, babylon, canvas })
  engine.addSystem({
    name: 'sandbox:status',
    phase: 'render',
    update() {
      status.textContent = `${name} | ${LABELS[babylon.backend]} | ${babylon.engine.getFps().toFixed(0)} FPS`
    },
  })
  engine.start()
}

// One switch at a time: a second click waits for the first load to finish.
let queue = Promise.resolve()
const go = () => {
  queue = queue.then(load).catch((error) => {
    status.textContent = String(error)
  })
}

for (const name of Object.keys(scenes)) {
  const link = document.createElement('a')
  link.href = `?scene=${name}`
  link.textContent = name
  link.onclick = (event) => {
    event.preventDefault()
    history.pushState(null, '', link.href)
    go()
  }
  nav.append(link)
}
addEventListener('popstate', go)
go()
