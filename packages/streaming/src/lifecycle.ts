/**
 * Where a chunk is in its life. `requesting` and `decoding` are the two halves of a load; `failed` is a
 * load that threw and is not retried until the chunk is dropped.
 */
export type ChunkState = 'unloaded' | 'requesting' | 'decoding' | 'ready' | 'unloading' | 'failed'

// requesting/decoding -> unloaded is a cancelled load.
const NEXT: Record<ChunkState, readonly ChunkState[]> = {
  unloaded: ['requesting'],
  requesting: ['decoding', 'unloaded', 'failed'],
  decoding: ['ready', 'unloaded', 'failed'],
  ready: ['unloading'],
  unloading: ['unloaded'],
  failed: ['unloaded'],
}

/** Returns `to` if a chunk in state `from` may move to it; throws otherwise. */
export function transition(from: ChunkState, to: ChunkState): ChunkState {
  if (!NEXT[from].includes(to)) throw new Error(`invalid chunk transition: ${from} -> ${to}`)
  return to
}
