import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { expect, test, vi } from 'vitest'
// Core by source: `pnpm test` runs without a build, and the workspace link points at core's dist.
import { createEngine } from '../../core/src/index.ts'
import { createBabylonEngine, type Factories } from '../src/backend.ts'
import { createPlugin } from '../src/plugin.ts'

const canvas = {} as HTMLCanvasElement
let onResize = () => {}
let observing = 0
vi.stubGlobal(
  'ResizeObserver',
  class {
    constructor(callback: () => void) {
      onResize = callback
    }
    observe = () => void observing++
    disconnect = () => void observing--
  },
)

function make(overrides: Partial<Factories> = {}) {
  const calls: string[] = []
  const create = (backend: string) => {
    calls.push(backend)
    return new NullEngine()
  }
  const factories: Factories = {
    webgpuSupported: async () => true,
    webgpu: async () => create('webgpu'),
    webgl2: () => create('webgl2'),
    ...overrides,
  }
  return { calls, factories }
}

async function install() {
  const core = createEngine({ canvas, fixedDt: 0.01, logLevel: 'silent' })
  const babylon = createPlugin({}, make().factories)
  await core.use(babylon)
  const render = vi.spyOn(babylon.scene, 'render')
  return { core, babylon, render }
}

test('the scene renders once per tick, inside a Babylon frame, whatever the number of fixed steps', async () => {
  const { core, babylon, render } = await install()
  const begin = vi.spyOn(babylon.engine, 'beginFrame')
  const end = vi.spyOn(babylon.engine, 'endFrame')
  new FreeCamera('camera', Vector3.Zero(), babylon.scene)
  core.tick(0)
  core.tick(35) // three fixed steps
  expect([begin, render, end].map((spy) => spy.mock.calls.length)).toEqual([2, 2, 2])
  expect(begin.mock.invocationCallOrder[0]).toBeLessThan(render.mock.invocationCallOrder[0] as number)
  expect(render.mock.invocationCallOrder[0]).toBeLessThan(end.mock.invocationCallOrder[0] as number)
})

test('a scene without a camera is skipped instead of throwing and getting the system disabled', async () => {
  const { core, babylon, render } = await install()
  const errors: unknown[] = []
  core.events.on('system:error', (e) => errors.push(e))
  core.tick(0)
  expect(render).not.toHaveBeenCalled()
  new FreeCamera('camera', Vector3.Zero(), babylon.scene)
  core.tick(16)
  expect(render).toHaveBeenCalledOnce()
  expect(errors).toEqual([])
})

test('a canvas resize is applied on the next frame', async () => {
  const { core, babylon } = await install()
  const resize = vi.spyOn(babylon.engine, 'resize')
  core.tick(0)
  expect(resize).not.toHaveBeenCalled()
  onResize()
  core.tick(16)
  core.tick(32)
  expect(resize).toHaveBeenCalledOnce()
})

test('dispose removes the render system and disposes scene and engine; the plugin installs again', async () => {
  const { core, babylon, render } = await install()
  const { scene, engine } = babylon
  new FreeCamera('camera', Vector3.Zero(), scene)
  const before = observing
  babylon.dispose()
  core.tick(0)
  expect(render).not.toHaveBeenCalled()
  expect([scene.isDisposed, engine.isDisposed, observing]).toEqual([true, true, before - 1])
  expect(() => babylon.scene).toThrow('not installed')
  babylon.dispose() // no-op
  await core.use(babylon)
  expect(babylon.scene).not.toBe(scene)
})

test('install needs a canvas and refuses to run twice', async () => {
  const { core, babylon } = await install()
  await expect(core.use(babylon)).rejects.toThrow('already installed')
  const headless = createEngine({ logLevel: 'silent' })
  await expect(headless.use(createPlugin({}, make().factories))).rejects.toThrow('canvas')
})

test('backend selection', async () => {
  const pick = async (requested: 'auto' | 'webgpu' | 'webgl2', overrides?: Partial<Factories>) => {
    const { calls, factories } = make(overrides)
    const warnings: unknown[] = []
    const { backend } = await createBabylonEngine(canvas, requested, (...args) => warnings.push(args), factories)
    return [backend, calls.join('+'), warnings.length]
  }
  const unsupported = { webgpuSupported: async () => false }
  const broken = { webgpu: () => Promise.reject(new Error('no device')) }
  expect(await pick('auto')).toEqual(['webgpu', 'webgpu', 0])
  expect(await pick('auto', unsupported)).toEqual(['webgl2', 'webgl2', 0])
  expect(await pick('webgl2')).toEqual(['webgl2', 'webgl2', 0])
  expect(await pick('webgpu', unsupported)).toEqual(['webgpu', 'webgpu', 0]) // explicit: tried without asking
  expect(await pick('auto', broken)).toEqual(['webgl2', 'webgl2', 1]) // init failed: warned, fell back
  expect(await pick('webgpu', broken)).toEqual(['webgl2', 'webgl2', 1])
})
