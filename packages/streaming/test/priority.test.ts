import { expect, test } from 'vitest'
import { loadPriority } from '../src/index.ts'

const here = { x: 0, z: 0 }

test('at rest the priority is the distance', () => {
  const still = { x: 0, z: 0 }
  expect(loadPriority({ x: 300, z: 400 }, here, still)).toBe(500)
  expect(loadPriority({ x: -300, z: 400 }, here, still)).toBe(500)
})

test('at 70 m/s the chunk ahead wins clearly over the one behind', () => {
  const car = { x: 70, z: 0 }
  const ahead = loadPriority({ x: 256, z: 0 }, here, car)
  const behind = loadPriority({ x: -256, z: 0 }, here, car)
  const beside = loadPriority({ x: 0, z: 256 }, here, car)
  expect(ahead).toBe(116)
  expect(behind).toBe(396)
  expect(ahead).toBeLessThan(beside)
  expect(beside).toBeLessThan(behind)
  // Even a chunk two cells ahead beats the one right behind.
  expect(loadPriority({ x: 512, z: 0 }, here, car)).toBeLessThan(behind)
})

test('the lookahead is configurable', () => {
  expect(loadPriority({ x: 100, z: 0 }, here, { x: 10, z: 0 }, 5)).toBe(50)
})
