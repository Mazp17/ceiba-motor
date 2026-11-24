import { expect, test } from 'vitest'
import { countStates, createFrameWindow, formatBytes, lateChunks } from '../src/stats.ts'

const chunk = (cx: number, cz: number, state: 'requesting' | 'decoding' | 'ready' | 'unloading' | 'failed') => {
  return { cx, cz, state, gpuBytes: 0, ramBytes: 0 }
}

test('an empty frame window reports zeros', () => {
  expect(createFrameWindow().stats()).toEqual({ fps: 0, average: 0, worst: 0 })
})

test('frame window: average, worst and fps', () => {
  const frames = createFrameWindow()
  for (const ms of [10, 20, 30]) frames.push(ms)
  expect(frames.stats()).toEqual({ fps: 50, average: 20, worst: 30 })
})

test('frame window forgets frames older than its size', () => {
  const frames = createFrameWindow(3)
  for (const ms of [100, 10, 10, 10]) frames.push(ms)
  expect(frames.stats()).toEqual({ fps: 100, average: 10, worst: 10 })
  frames.push(40)
  expect(frames.stats()).toEqual({ fps: 50, average: 20, worst: 40 })
})

test('frame window: zero-length frames do not divide by zero', () => {
  const frames = createFrameWindow()
  frames.push(0)
  expect(frames.stats()).toEqual({ fps: 0, average: 0, worst: 0 })
})

test('countStates counts every state, zero included', () => {
  expect(countStates([])).toEqual({ requesting: 0, decoding: 0, ready: 0, unloading: 0, failed: 0 })
  const chunks = [chunk(0, 0, 'ready'), chunk(1, 0, 'ready'), chunk(2, 0, 'requesting'), chunk(3, 0, 'failed')]
  expect(countStates(chunks)).toEqual({ requesting: 1, decoding: 0, ready: 2, unloading: 0, failed: 1 })
})

test('formatBytes', () => {
  expect(formatBytes(0)).toBe('0.0 MB')
  expect(formatBytes(12_345_678)).toBe('12.3 MB')
  expect(formatBytes(512e6)).toBe('512.0 MB')
  expect(formatBytes(Infinity)).toBe('∞')
})

test('a chunk is late once it has been loading for longer than the limit', () => {
  const since = new Map<string, number>()
  const chunks = [chunk(1, -2, 'requesting'), chunk(0, 0, 'ready')]
  expect(lateChunks(since, chunks, 1000, 500)).toEqual(new Set())
  expect(lateChunks(since, chunks, 1500, 500)).toEqual(new Set()) // exactly the limit is not late
  expect(lateChunks(since, chunks, 1501, 500)).toEqual(new Set(['1,-2']))
})

test('requesting then decoding is one load: the clock does not restart', () => {
  const since = new Map<string, number>()
  lateChunks(since, [chunk(0, 0, 'requesting')], 0, 500)
  expect(lateChunks(since, [chunk(0, 0, 'decoding')], 600, 500)).toEqual(new Set(['0,0']))
})

test('a chunk that stops loading is forgotten, and starts from zero if it loads again', () => {
  const since = new Map<string, number>()
  lateChunks(since, [chunk(0, 0, 'requesting')], 0, 500)
  expect(lateChunks(since, [chunk(0, 0, 'ready')], 600, 500)).toEqual(new Set())
  expect(since.size).toBe(0)
  lateChunks(since, [], 700, 500)
  expect(lateChunks(since, [chunk(0, 0, 'requesting')], 800, 500)).toEqual(new Set())
  expect(lateChunks(since, [chunk(0, 0, 'requesting')], 1301, 500)).toEqual(new Set(['0,0']))
})

test('states that are not a load are never late', () => {
  const since = new Map<string, number>()
  const chunks = [chunk(0, 0, 'ready'), chunk(1, 0, 'unloading'), chunk(2, 0, 'failed')]
  lateChunks(since, chunks, 0, 500)
  expect(lateChunks(since, chunks, 10_000, 500)).toEqual(new Set())
})
