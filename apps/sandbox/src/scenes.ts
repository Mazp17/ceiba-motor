import type { BabylonPlugin } from '@ceiba/babylon'
import type { Engine } from '@ceiba/core'

export interface SceneContext {
  engine: Engine
  babylon: BabylonPlugin
  canvas: HTMLCanvasElement
}

export interface SandboxScene {
  /** Seconds per fixed step. The core default (1/60) when omitted. */
  fixedDt?: number
  /**
   * Builds the scene and returns its teardown. Systems and Babylon nodes need no cleanup: the engine
   * and the Babylon scene are thrown away on a switch. Undo only what outlives them (DOM listeners).
   */
  setup(context: SceneContext): (() => void) | Promise<() => void>
}

/** `?scene=<key>`. Each scene is its own chunk, loaded on demand. */
export const scenes: Record<string, () => Promise<{ default: SandboxScene }>> = {
  hello: () => import('./scenes/hello.ts'),
  world: () => import('./scenes/world.ts'),
}
