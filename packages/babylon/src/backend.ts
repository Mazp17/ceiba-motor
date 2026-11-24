import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js'
import { Engine } from '@babylonjs/core/Engines/engine.js'

/** The graphics API the Babylon engine ended up running on. */
export type Backend = 'webgpu' | 'webgl2'

// Internal seam: tests replace it to run without a GPU.
export interface Factories {
  webgpuSupported(): Promise<boolean>
  webgpu(canvas: HTMLCanvasElement): Promise<AbstractEngine>
  webgl2(canvas: HTMLCanvasElement): AbstractEngine
}

export const browser: Factories = {
  // Same test as Babylon's WebGPUEngine.IsSupportedAsync, without downloading the WebGPU engine to ask.
  webgpuSupported: async () => !!(await navigator.gpu?.requestAdapter().catch(() => null)),
  async webgpu(canvas) {
    // Dynamic import: a WebGL2 session never downloads the WebGPU engine.
    const { WebGPUEngine } = await import('@babylonjs/core/Engines/webgpuEngine.js')
    const engine = new WebGPUEngine(canvas)
    await engine.initAsync()
    return engine
  },
  webgl2: (canvas) => new Engine(canvas, true),
}

/** `auto` asks the browser; an explicit `webgpu` is tried without asking. Any WebGPU failure ends in WebGL2. */
export async function createBabylonEngine(
  canvas: HTMLCanvasElement,
  requested: 'auto' | Backend,
  warn: (...args: unknown[]) => void,
  factories: Factories,
): Promise<{ engine: AbstractEngine; backend: Backend }> {
  if (requested === 'webgpu' || (requested === 'auto' && (await factories.webgpuSupported()))) {
    try {
      return { engine: await factories.webgpu(canvas), backend: 'webgpu' }
    } catch (error) {
      // shortcut: assumes WebGPU failed before taking the canvas context (adapter or device request);
      // a later failure leaves the canvas unusable for WebGL2. Recreate the canvas if that shows up.
      warn('WebGPU failed to initialise, falling back to WebGL2', error)
    }
  }
  return { engine: factories.webgl2(canvas), backend: 'webgl2' }
}
