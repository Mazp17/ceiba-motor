import type { ChunkSnapshot, ChunkState } from '@ceiba/streaming'

/** The chunk states a streamer snapshot can list: every state but `unloaded`. */
export type ShownState = Exclude<ChunkState, 'unloaded'>

/** In the order the legend shows them. */
export const SHOWN_STATES: readonly ShownState[] = ['requesting', 'decoding', 'ready', 'unloading', 'failed']

/** Frame times of the last `size` frames. */
export interface FrameWindow {
  /** Records one frame, in milliseconds. */
  push(ms: number): void
  /** Average and worst frame time in the window, and the FPS that average gives. All 0 while empty. */
  stats(): { fps: number; average: number; worst: number }
}

/** Creates a window over the last `size` frames (default 120, two seconds at 60 FPS). */
export function createFrameWindow(size = 120): FrameWindow {
  const frames: number[] = []
  let next = 0
  return {
    push(ms) {
      frames[next] = ms
      next = (next + 1) % size
    },
    stats() {
      if (!frames.length) return { fps: 0, average: 0, worst: 0 }
      const average = frames.reduce((sum, ms) => sum + ms, 0) / frames.length
      return { fps: average ? 1000 / average : 0, average, worst: Math.max(...frames) }
    },
  }
}

/** How many chunks of a snapshot are in each state. */
export function countStates(chunks: readonly ChunkSnapshot[]): Record<ShownState, number> {
  const counts = { requesting: 0, decoding: 0, ready: 0, unloading: 0, failed: 0 }
  for (const chunk of chunks) if (chunk.state !== 'unloaded') counts[chunk.state]++
  return counts
}

/** Bytes as decimal megabytes with one decimal, e.g. `12.3 MB`. An unlimited budget (`Infinity`) is `∞`. */
export function formatBytes(bytes: number): string {
  return Number.isFinite(bytes) ? `${(bytes / 1e6).toFixed(1)} MB` : '∞'
}

/**
 * Tracks how long each chunk has been loading. `since` is the caller's memory between calls: it maps a
 * chunk key (`"cx,cz"`) to the time it was first seen `requesting` or `decoding`, and is updated in place.
 * Returns the keys of the chunks that have been loading for more than `lateMs`.
 */
export function lateChunks(
  since: Map<string, number>,
  chunks: readonly ChunkSnapshot[],
  now: number,
  lateMs: number,
): Set<string> {
  const loading = new Set<string>()
  const late = new Set<string>()
  for (const { cx, cz, state } of chunks) {
    if (state !== 'requesting' && state !== 'decoding') continue
    const key = `${cx},${cz}`
    loading.add(key)
    if (!since.has(key)) since.set(key, now)
    if (now - (since.get(key) ?? now) > lateMs) late.add(key)
  }
  for (const key of since.keys()) if (!loading.has(key)) since.delete(key)
  return late
}
