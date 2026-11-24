/** Integer indices of a chunk on the world grid. The only absolute coordinate that is ever stored. */
export interface ChunkId {
  cx: number
  cz: number
}

/** A point or offset on the ground plane, in metres. */
export interface Vec2 {
  x: number
  z: number
}

/** Stable map key for a chunk, e.g. `"-3,12"`. */
export function chunkKey(chunk: ChunkId): string {
  return `${chunk.cx},${chunk.cz}`
}

/** Distance in whole chunks, counting diagonals as 1 (Chebyshev). Every radius in this package uses it. */
export function chunkDistance(a: ChunkId, b: ChunkId): number {
  return Math.max(Math.abs(a.cx - b.cx), Math.abs(a.cz - b.cz))
}

/** Every chunk within `radius` chunks of `center`: a square of side `2 * radius + 1`. */
export function chunksWithin(center: ChunkId, radius: number): ChunkId[] {
  const chunks: ChunkId[] = []
  for (let cz = center.cz - radius; cz <= center.cz + radius; cz++)
    for (let cx = center.cx - radius; cx <= center.cx + radius; cx++) chunks.push({ cx, cz })
  return chunks
}

/** Scene position, in metres, of the minimum corner of a chunk: `(chunk - origin) * chunkSize`. */
export function chunkToScene(chunk: ChunkId, origin: ChunkId, chunkSize: number): Vec2 {
  return { x: (chunk.cx - origin.cx) * chunkSize, z: (chunk.cz - origin.cz) * chunkSize }
}

/** The chunk that contains a scene position. Subtract `chunkToScene` of the result to get chunk-local metres. */
export function sceneToChunk(position: Vec2, origin: ChunkId, chunkSize: number): ChunkId {
  return { cx: origin.cx + Math.floor(position.x / chunkSize), cz: origin.cz + Math.floor(position.z / chunkSize) }
}

/**
 * Origin shift rule: when `focus` is more than `threshold` chunks from `origin`, the origin snaps to
 * `focus`. Returns the new origin and the `delta`, in metres, to add to every scene position (nodes,
 * physics bodies, cached positions); `null` when no shift is due. Keep `threshold` above 1 so a focus
 * that hovers on a chunk border does not shift back and forth.
 */
export function shiftOrigin(
  origin: ChunkId,
  focus: ChunkId,
  chunkSize: number,
  threshold = 2,
): { origin: ChunkId; delta: Vec2 } | null {
  if (chunkDistance(origin, focus) <= threshold) return null
  return { origin: focus, delta: chunkToScene(origin, focus, chunkSize) }
}
