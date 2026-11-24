import { expect, test } from 'vitest'
import { createEngine, type Phase } from '../src/index.ts'

const make = () => createEngine({ fixedDt: 0.01, logLevel: 'silent' })

test('fixed step runs whole steps and leaves the rest as alpha', () => {
  const engine = make()
  let steps = 0
  const alphas: number[] = []
  engine.addSystem({ name: 'sim', phase: 'update', update: () => void steps++ })
  engine.addSystem({ name: 'draw', phase: 'render', update: (f) => void alphas.push(f.alpha) })
  engine.tick(0)
  engine.tick(35)
  expect(steps).toBe(3)
  expect(alphas.at(-1)).toBeCloseTo(0.5)
  expect(engine.clock.time).toBeCloseTo(0.03)
})

test('systems run by phase, then by order', () => {
  const engine = make()
  const seen: string[] = []
  const add = (name: string, phase: Phase, order?: number) =>
    engine.addSystem({ name, phase, order, update: () => void seen.push(name) })
  add('render', 'render')
  add('late', 'lateUpdate')
  add('physics', 'physics')
  add('b', 'update', 2)
  add('a', 'update', 1)
  add('input', 'input')
  engine.tick(0)
  engine.tick(10)
  expect(seen.slice(-6)).toEqual(['input', 'a', 'b', 'physics', 'late', 'render'])
})

test('a failing system is disabled and the rest keep running', () => {
  const engine = make()
  let bad = 0
  let good = 0
  const errors: string[] = []
  engine.events.on('system:error', (e) => errors.push(e.system))
  engine.addSystem({
    name: 'bad',
    phase: 'input',
    update: () => {
      bad++
      throw new Error('boom')
    },
  })
  engine.addSystem({ name: 'good', phase: 'input', update: () => void good++ })
  engine.tick(0)
  engine.tick(16)
  expect([bad, good, errors]).toEqual([1, 2, ['bad']])
})

test('pause stops the simulation, timeScale scales it, a stall drops the backlog', () => {
  const engine = make()
  let steps = 0
  engine.addSystem({ name: 'sim', phase: 'update', update: () => void steps++ })
  engine.tick(0)
  engine.clock.paused = true
  engine.tick(100)
  expect(steps).toBe(0)
  engine.clock.paused = false
  engine.clock.timeScale = 0.5
  engine.tick(145)
  expect(steps).toBe(2)
  engine.clock.timeScale = 1
  engine.tick(10_000)
  expect(steps).toBe(10) // maxSubSteps = 8
})

test('duplicate system names are rejected; event handlers unsubscribe', () => {
  const engine = make()
  const system = { name: 'x', phase: 'update' as const, update() {} }
  engine.addSystem(system)
  expect(() => engine.addSystem(system)).toThrow()
  let calls = 0
  const off = engine.events.on('system:error', () => void calls++)
  off()
  engine.events.emit('system:error', { system: 'x', error: null })
  expect(calls).toBe(0)
})

test('use installs the plugin with the engine', () => {
  const engine = make()
  const got: unknown[] = []
  engine.use({ name: 'p', install: (e) => void got.push(e) })
  expect(got[0]).toBe(engine)
})

test('removeSystem takes effect in the same frame and the system can be added again', () => {
  const engine = make()
  let draws = 0
  const draw = { name: 'draw', phase: 'render' as const, update: () => void draws++ }
  engine.addSystem(draw)
  engine.addSystem({ name: 'remover', phase: 'input', update: () => engine.removeSystem('draw') })
  engine.tick(0)
  expect(draws).toBe(0)
  engine.removeSystem('remover')
  engine.removeSystem('unknown')
  engine.addSystem(draw)
  engine.tick(16)
  expect(draws).toBe(1)
})

test('enableSystem turns a failed system back on', () => {
  const engine = make()
  let calls = 0
  engine.addSystem({
    name: 'flaky',
    phase: 'input',
    update: () => {
      if (++calls === 1) throw new Error('boom')
    },
  })
  engine.tick(0)
  engine.tick(16)
  expect(calls).toBe(1)
  engine.enableSystem('flaky')
  engine.tick(32)
  expect(calls).toBe(2)
})
