import type { Vec2 } from './grid.ts'

/**
 * Load priority of a chunk; lower loads first. It is the distance from the chunk centre to where the
 * focus will be in `lookahead` seconds, so chunks ahead of the movement beat chunks behind it and a
 * focus at rest falls back to plain distance. All arguments share one frame (scene metres, m/s).
 */
export function loadPriority(chunkCenter: Vec2, position: Vec2, velocity: Vec2, lookahead = 2): number {
  return Math.hypot(
    chunkCenter.x - position.x - velocity.x * lookahead,
    chunkCenter.z - position.z - velocity.z * lookahead,
  )
}
