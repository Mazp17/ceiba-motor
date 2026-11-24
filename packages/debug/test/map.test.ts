import { expect, test } from 'vitest'
// Streaming by source: `pnpm test` runs without a build, and the workspace link points at its dist.
import { sceneToChunk } from '../../streaming/src/index.ts'
import { layoutMap, type MapInput, STATE_COLORS } from '../src/map.ts'
import { SHOWN_STATES } from '../src/stats.ts'

// unloadRadius 3 -> the map reaches 4 chunks: 9 cells per side, 10 px each on a 90 px canvas.
const base: MapInput = {
  chunks: [],
  origin: { cx: 0, cz: 0 },
  position: { x: 50, z: 50 },
  chunkSize: 100,
  loadRadius: 2,
  unloadRadius: 3,
  size: 90,
}
const ready = (cx: number, cz: number) => ({ cx, cz, state: 'ready' as const, gpuBytes: 0, ramBytes: 0 })

test('every shown state has its own colour', () => {
  expect(Object.keys(STATE_COLORS).sort()).toEqual([...SHOWN_STATES].sort())
  expect(new Set(Object.values(STATE_COLORS)).size).toBe(SHOWN_STATES.length)
})

test('the focus chunk is the centre cell', () => {
  const map = layoutMap({ ...base, chunks: [ready(0, 0)] })
  expect(map.focusChunk).toEqual({ cx: 0, cz: 0 })
  expect(map.cells).toEqual([{ x: 40, y: 40, size: 10, key: '0,0', state: 'ready' }])
})

test('+x is right and +z is up', () => {
  const map = layoutMap({ ...base, chunks: [ready(1, 0), ready(0, 1), ready(-4, -4), ready(4, 4)] })
  expect(map.cells.map(({ x, y }) => [x, y])).toEqual([
    [50, 40],
    [40, 30],
    [0, 80],
    [80, 0],
  ])
})

test('chunks past the edge of the map are left out', () => {
  const map = layoutMap({ ...base, chunks: [ready(5, 0), ready(0, -5), ready(4, 0)] })
  expect(map.cells.map((cell) => cell.key)).toEqual(['4,0'])
})

test('each cell keeps the state of its chunk', () => {
  const chunks = SHOWN_STATES.map((state, cx) => ({ cx, cz: 0, state, gpuBytes: 0, ramBytes: 0 }))
  expect(layoutMap({ ...base, chunks }).cells.map((cell) => cell.state)).toEqual(SHOWN_STATES)
})

test('radius outlines are squares around the focus chunk', () => {
  const map = layoutMap(base)
  expect(map.load).toEqual({ x: 20, y: 20, size: 50 })
  expect(map.unload).toEqual({ x: 10, y: 10, size: 70 })
})

test('the focus chunk follows the position and is offset by the origin', () => {
  const map = layoutMap({ ...base, origin: { cx: 10, cz: -5 }, position: { x: 250, z: -1 }, chunks: [ready(12, -6)] })
  expect(map.focusChunk).toEqual({ cx: 12, cz: -6 })
  expect(map.focusChunk).toEqual(sceneToChunk({ x: 250, z: -1 }, { cx: 10, cz: -5 }, 100))
  expect(map.cells[0]).toMatchObject({ x: 40, y: 40 })
})

test('the origin cell moves away from the centre as the focus leaves it', () => {
  expect(layoutMap(base).origin).toEqual({ x: 40, y: 40, size: 10 })
  expect(layoutMap({ ...base, position: { x: 250, z: 150 } }).origin).toEqual({ x: 20, y: 50, size: 10 })
  expect(layoutMap({ ...base, position: { x: 550, z: 50 } }).origin).toBeNull()
})

test('after an origin shift the same world chunk stays in place and only the origin cell moves', () => {
  const chunks = [ready(3, 0)]
  const before = layoutMap({ ...base, chunks, position: { x: 350, z: 50 } })
  // The streamer snapped the origin to the focus chunk and the game subtracted 300 m from the position.
  const after = layoutMap({ ...base, chunks, origin: { cx: 3, cz: 0 }, position: { x: 50, z: 50 } })
  expect(after.focusChunk).toEqual(before.focusChunk)
  expect(after.cells).toEqual(before.cells)
  expect(after.focus).toEqual(before.focus)
  expect(before.origin).toEqual({ x: 10, y: 40, size: 10 })
  expect(after.origin).toEqual({ x: 40, y: 40, size: 10 })
})

test('the focus point is placed inside its cell', () => {
  expect(layoutMap(base).focus).toMatchObject({ x: 45, y: 45 })
  // Near the +x / +z corner of the chunk: right and up.
  const corner = layoutMap({ ...base, position: { x: 90, z: 80 } }).focus
  expect(corner.x).toBeCloseTo(49)
  expect(corner.y).toBeCloseTo(42)
  // Negative positions: chunk -1, 25 m from its minimum corner.
  const negative = layoutMap({ ...base, position: { x: -75, z: -75 } })
  expect(negative.focusChunk).toEqual({ cx: -1, cz: -1 })
  expect(negative.focus.x).toBeCloseTo(42.5)
  expect(negative.focus.y).toBeCloseTo(47.5)
})

test('heading: 0 looks along +z (up), a quarter turn looks along +x (right)', () => {
  const up = layoutMap({ ...base, heading: 0 }).focus
  expect(up.dx).toBeCloseTo(0)
  expect(up.dy).toBeCloseTo(-1)
  const right = layoutMap({ ...base, heading: Math.PI / 2 }).focus
  expect(right.dx).toBeCloseTo(1)
  expect(right.dy).toBeCloseTo(0)
  expect(layoutMap(base).focus).toMatchObject({ dx: 0, dy: 0 })
})
