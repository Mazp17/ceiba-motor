import type { ChunkId, ChunkSnapshot } from '@ceiba/streaming'
import type { ShownState } from './stats.ts'

/** Fill colour of a map cell per chunk state. `unloaded` chunks are not drawn. */
export const STATE_COLORS: Record<ShownState, string> = {
  requesting: '#f5a524',
  decoding: '#4c9aff',
  ready: '#2fb170',
  unloading: '#8a8f98',
  failed: '#ef4444',
}

/** A square on the map canvas, in pixels from its top-left corner. */
export interface Square {
  x: number
  y: number
  size: number
}

/** What `layoutMap` needs. */
export interface MapInput {
  chunks: readonly ChunkSnapshot[]
  /** The streamer's origin chunk. */
  origin: ChunkId
  /** Focus position in scene metres relative to `origin`: what `streamer.update` receives. */
  position: { x: number; z: number }
  /** Radians, 0 looking along +z and growing towards +x (a Babylon `rotation.y`). */
  heading?: number
  /** Metres per chunk side. */
  chunkSize: number
  loadRadius: number
  unloadRadius: number
  /** Side of the square canvas, in pixels. */
  size: number
}

/** Where everything goes on the map canvas. +x is right and +z is up; the focus chunk is the centre cell. */
export interface MapLayout {
  /** The chunk the focus is in. */
  focusChunk: ChunkId
  /** One per listed chunk that falls inside the map. `key` is `"cx,cz"`. */
  cells: (Square & { key: string; state: ShownState })[]
  /** The origin chunk's cell, or `null` when it is off the map. */
  origin: Square | null
  /** Outline of the chunks within the load radius. */
  load: Square
  /** Outline of the chunks within the unload radius. */
  unload: Square
  /** Focus position in pixels, and its heading as a unit vector in canvas axes (0, 0 without a heading). */
  focus: { x: number; y: number; dx: number; dy: number }
}

/**
 * Lays out a top-down map centred on the focus chunk that reaches one chunk past the unload radius,
 * so a chunk that should already be gone is still visible.
 */
export function layoutMap(input: MapInput): MapLayout {
  const { origin, position, chunkSize, heading } = input
  const reach = input.unloadRadius + 1
  const cell = input.size / (2 * reach + 1)
  const fx = Math.floor(position.x / chunkSize)
  const fz = Math.floor(position.z / chunkSize)
  const focusChunk = { cx: origin.cx + fx, cz: origin.cz + fz }
  const square = (chunk: ChunkId, radius = 0): Square | null => {
    const col = chunk.cx - focusChunk.cx
    const row = chunk.cz - focusChunk.cz
    if (Math.max(Math.abs(col), Math.abs(row)) > reach) return null
    return { x: (reach + col - radius) * cell, y: (reach - row - radius) * cell, size: (2 * radius + 1) * cell }
  }
  const cells: MapLayout['cells'] = []
  for (const chunk of input.chunks) {
    const at = square(chunk)
    if (at && chunk.state !== 'unloaded') cells.push({ ...at, key: `${chunk.cx},${chunk.cz}`, state: chunk.state })
  }
  return {
    focusChunk,
    cells,
    origin: square(origin),
    load: square(focusChunk, input.loadRadius) as Square,
    unload: square(focusChunk, input.unloadRadius) as Square,
    focus: {
      x: (reach + position.x / chunkSize - fx) * cell,
      y: (reach + 1 - (position.z / chunkSize - fz)) * cell,
      dx: heading === undefined ? 0 : Math.sin(heading),
      dy: heading === undefined ? 0 : -Math.cos(heading),
    },
  }
}
