import { expect, test } from 'vitest'
import { chunkDistance, chunkKey, chunksWithin, chunkToScene, sceneToChunk, shiftOrigin } from '../src/index.ts'

test('chunkKey is stable and distinct, including negative indices', () => {
  expect(chunkKey({ cx: -3, cz: 12 })).toBe('-3,12')
  expect(chunkKey({ cx: 1, cz: -1 })).not.toBe(chunkKey({ cx: -1, cz: 1 }))
})

test('scene position of a chunk is (chunk - origin) * chunkSize', () => {
  expect(chunkToScene({ cx: 5, cz: -2 }, { cx: 3, cz: 1 }, 256)).toEqual({ x: 512, z: -768 })
  expect(chunkToScene({ cx: -400, cz: -400 }, { cx: -400, cz: -400 }, 256)).toEqual({ x: 0, z: 0 })
})

test('sceneToChunk floors towards negative infinity and adds the origin', () => {
  const origin = { cx: 0, cz: 0 }
  expect(sceneToChunk({ x: 0, z: 255.9 }, origin, 256)).toEqual({ cx: 0, cz: 0 })
  expect(sceneToChunk({ x: 256, z: -0.1 }, origin, 256)).toEqual({ cx: 1, cz: -1 })
  expect(sceneToChunk({ x: -256, z: -256.1 }, origin, 256)).toEqual({ cx: -1, cz: -2 })
  expect(sceneToChunk({ x: -1, z: 300 }, { cx: -390, cz: 390 }, 256)).toEqual({ cx: -391, cz: 391 })
})

test('sceneToChunk and chunkToScene round-trip, leaving chunk-local metres', () => {
  const origin = { cx: -7, cz: 4 }
  const position = { x: -700.5, z: 1000.25 }
  const chunk = sceneToChunk(position, origin, 256)
  const corner = chunkToScene(chunk, origin, 256)
  expect(chunk).toEqual({ cx: -10, cz: 7 })
  expect({ x: position.x - corner.x, z: position.z - corner.z }).toEqual({ x: 67.5, z: 232.25 })
})

test('chunkDistance counts diagonals as 1', () => {
  expect(chunkDistance({ cx: -2, cz: 1 }, { cx: 1, cz: -1 })).toBe(3)
  expect(chunkDistance({ cx: 4, cz: 4 }, { cx: 4, cz: 4 })).toBe(0)
})

test('chunksWithin returns the square around the center', () => {
  expect(chunksWithin({ cx: 9, cz: 9 }, 0)).toEqual([{ cx: 9, cz: 9 }])
  const near = chunksWithin({ cx: -1, cz: 0 }, 2)
  expect(near).toHaveLength(25)
  expect(new Set(near.map(chunkKey)).size).toBe(25)
  expect(near.every((chunk) => chunkDistance(chunk, { cx: -1, cz: 0 }) <= 2)).toBe(true)
  expect(near).toContainEqual({ cx: -3, cz: -2 })
})

test('the origin shifts only when the focus is more than the threshold away', () => {
  const origin = { cx: 0, cz: 0 }
  expect(shiftOrigin(origin, { cx: 2, cz: -2 }, 256)).toBeNull()
  expect(shiftOrigin(origin, { cx: 3, cz: 0 }, 256)).toEqual({ origin: { cx: 3, cz: 0 }, delta: { x: -768, z: 0 } })
  expect(shiftOrigin(origin, { cx: -1, cz: -2 }, 256, 1)).toEqual({
    origin: { cx: -1, cz: -2 },
    delta: { x: 256, z: 512 },
  })
})

test('the shift delta keeps a point in the same place of the world', () => {
  const origin = { cx: 10, cz: -5 }
  const position = { x: 800, z: -900 }
  const shift = shiftOrigin(origin, sceneToChunk(position, origin, 256), 256)
  if (!shift) throw new Error('expected a shift')
  const moved = { x: position.x + shift.delta.x, z: position.z + shift.delta.z }
  expect(sceneToChunk(moved, shift.origin, 256)).toEqual(sceneToChunk(position, origin, 256))
  expect(moved).toEqual({ x: 32, z: 124 })
})

test('a focus hovering on a chunk border does not make the origin ping-pong', () => {
  let origin = { cx: 0, cz: 0 }
  let shifts = 0
  // Walk out to chunk 3, then hover on the border between chunks 2 and 3.
  for (const cx of [1, 2, 3, 2, 3, 2, 3, 2, 3]) {
    const shift = shiftOrigin(origin, { cx, cz: 0 }, 256)
    if (shift) {
      origin = shift.origin
      shifts++
    }
  }
  expect(shifts).toBe(1)
  expect(origin).toEqual({ cx: 3, cz: 0 })
})
