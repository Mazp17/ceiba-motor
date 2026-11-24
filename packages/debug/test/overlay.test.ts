import { afterEach, beforeEach, expect, test, vi } from 'vitest'
// Core by source: `pnpm test` runs without a build, and the workspace link points at core's dist.
import { createEngine } from '../../core/src/index.ts'
import { type DebugOptions, debugPlugin } from '../src/overlay.ts'

// A stand-in for the few DOM members the overlay touches: enough to drive its logic (throttling, toggling,
// errors, actions) in Node. It proves nothing about how the overlay looks.
class FakeElement {
  style = { cssText: '' }
  textContent = ''
  hidden = false
  children: FakeElement[] = []
  onclick = () => {}
  constructor(readonly tag: string) {}
  append(child: FakeElement) {
    this.children.push(child)
  }
  replaceChildren() {
    this.children = []
  }
  remove() {
    body.children = body.children.filter((child) => child !== this)
  }
  // Any canvas call is accepted and ignored.
  getContext = () => new Proxy({}, { get: () => () => {}, set: () => true })
}

let body: FakeElement
let now = 0
let keydown: (event: { code: string }) => void = () => {}
const removeEventListener = vi.fn()

beforeEach(() => {
  body = new FakeElement('body')
  now = 0
  removeEventListener.mockClear()
  vi.stubGlobal('document', { body, createElement: (tag: string) => new FakeElement(tag) })
  vi.stubGlobal('window', {
    addEventListener: (_type: string, listener: typeof keydown) => {
      keydown = listener
    },
    removeEventListener,
  })
  vi.stubGlobal('location', { search: '?debug' })
  vi.stubGlobal('devicePixelRatio', 1)
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function setup(options: DebugOptions = {}) {
  const engine = createEngine({ logLevel: 'silent' })
  const debug = debugPlugin(options)
  engine.use(debug)
  engine.tick(0)
  /** Runs frames of 10 ms until `ms` have passed. */
  const run = (ms: number) => {
    for (const end = now + ms; now < end; ) {
      now += 10
      engine.tick(now)
    }
  }
  return { engine, debug, run }
}

const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)]
const text = () =>
  all(body)
    .map((node) => node.textContent)
    .join('\n')
const click = (label: string) =>
  all(body)
    .find((node) => node.tag === 'button' && node.textContent === label)
    ?.onclick()

function fakeStreaming() {
  const state = { origin: { cx: 0, cz: 0 }, overBudget: false }
  const snapshot = vi.fn(() => ({
    gpuBytes: 100e6,
    ramBytes: 20e6,
    overBudget: state.overBudget,
    chunks: [
      { cx: 0, cz: 0, state: 'ready' as const, gpuBytes: 60e6, ramBytes: 10e6 },
      { cx: 1, cz: 0, state: 'ready' as const, gpuBytes: 40e6, ramBytes: 10e6 },
      { cx: 0, cz: 1, state: 'requesting' as const, gpuBytes: 0, ramBytes: 0 },
    ],
  }))
  const streaming: DebugOptions['streaming'] = {
    streamer: {
      get origin() {
        return state.origin
      },
      snapshot,
    },
    chunkSize: 100,
    gpuBudget: 512e6,
    ramBudget: Infinity,
    focus: () => ({ x: 150, z: 50, heading: 0 }),
  }
  return { state, snapshot, streaming }
}

test('hidden without the URL parameter: no DOM and nothing is read', () => {
  vi.stubGlobal('location', { search: '?other=1' })
  const renderStats = vi.fn(() => ({ drawCalls: 0, triangles: 0, activeMeshes: 0 }))
  const { snapshot, streaming } = fakeStreaming()
  const { debug, run } = setup({ renderStats, streaming })
  run(1000)
  expect(debug.visible).toBe(false)
  expect(body.children).toEqual([])
  expect(renderStats).not.toHaveBeenCalled()
  expect(snapshot).not.toHaveBeenCalled()
  expect(performance.now).not.toHaveBeenCalled()
})

test('the URL parameter shows it, and its name is configurable', () => {
  expect(setup().debug.visible).toBe(true)
  expect(setup({ param: 'dev' }).debug.visible).toBe(false)
  vi.stubGlobal('location', { search: '?x=1&dev' })
  expect(setup({ param: 'dev' }).debug.visible).toBe(true)
})

test('the toggle key and `visible` show and hide the same element', () => {
  vi.stubGlobal('location', { search: '' })
  const { debug } = setup({ toggleKey: 'F3' })
  keydown({ code: 'Backquote' })
  expect(debug.visible).toBe(false)
  keydown({ code: 'F3' })
  expect(debug.visible).toBe(true)
  expect(body.children).toHaveLength(1)
  keydown({ code: 'F3' })
  expect(debug.visible).toBe(false)
  expect(body.children[0]?.hidden).toBe(true)
  debug.visible = true
  expect(body.children).toHaveLength(1)
  expect(body.children[0]?.hidden).toBe(false)
})

test('performance text: fps, frame time and fixed steps', () => {
  const { run } = setup()
  run(1000)
  expect(text()).toContain('100 fps  frame 10.0 ms avg  10.0 ms worst')
  // 10 ms frames on a 1/60 s step: 0 or 1 step per frame.
  expect(text()).toMatch(/fixed steps\/frame 0\.6 avg {2}1 max/)
})

test('the worst frame stands out from the average', () => {
  const { engine, run } = setup()
  run(500)
  now += 80
  engine.tick(now)
  run(300)
  expect(text()).toContain('80.0 ms worst')
  expect(text()).toMatch(/fixed steps\/frame .* avg {2}[45] max/)
})

test('text is refreshed 4 times per second and the map 10 times, not every frame', () => {
  const renderStats = vi.fn(() => ({ drawCalls: 7, triangles: 1200, activeMeshes: 3 }))
  const { snapshot, streaming } = fakeStreaming()
  const { run } = setup({ renderStats, streaming })
  run(1000) // 100 frames after the one at t = 0, which refreshes both
  expect(renderStats).toHaveBeenCalledTimes(5)
  expect(snapshot).toHaveBeenCalledTimes(11)
  expect(text()).toContain('draw calls 7  triangles 1200  active meshes 3')
})

test('time spent hidden is not counted as a frame', () => {
  const { debug, run } = setup()
  run(300)
  debug.visible = false
  run(5000)
  debug.visible = true
  run(300)
  expect(text()).toContain('10.0 ms worst')
})

test('streaming text: budgets, counts per state, focus and origin', () => {
  const { streaming } = fakeStreaming()
  const { run } = setup({ streaming })
  run(300)
  expect(text()).toContain('GPU 100.0 MB / 512.0 MB  RAM 20.0 MB / ∞')
  expect(text()).not.toContain('OVER BUDGET')
  expect(text()).toContain('focus 1,0  origin 0,0  late 0')
  for (const count of ['requesting 1', 'decoding 0', 'ready 2', 'unloading 0', 'failed 0']) {
    expect(text()).toContain(count)
  }
  // The legend is there from the start.
  for (const label of ['origin', 'load radius', 'unload radius']) expect(text()).toContain(`\n${label}\n`)
})

test('over budget is flagged', () => {
  const { state, streaming } = fakeStreaming()
  const { run } = setup({ streaming })
  state.overBudget = true
  run(300)
  expect(text()).toContain('OVER BUDGET')
})

test('a chunk that keeps loading is counted as late', () => {
  const { streaming } = fakeStreaming()
  const { run } = setup({ streaming })
  run(900)
  expect(text()).toContain('late 0')
  run(500)
  expect(text()).toContain('late 1')
})

test('an origin shift is counted and timed', () => {
  const { state, streaming } = fakeStreaming()
  const { run } = setup({ streaming })
  run(300)
  expect(text()).toContain('origin shifts 0')
  state.origin = { cx: 3, cz: 0 }
  run(1000)
  expect(text()).toContain('origin 3,0')
  expect(text()).toMatch(/origin shifts 1 {2}last (0\.[89]|1\.0) s ago/)
})

test('a system disabled by an error is listed, and its button re-enables it', () => {
  const { engine, run } = setup()
  let fail = true
  let runs = 0
  engine.addSystem({
    name: 'flaky',
    phase: 'lateUpdate',
    update() {
      if (fail) throw new Error('boom')
      runs++
    },
  })
  run(50)
  expect(text()).toContain('flaky disabled: Error: boom')
  expect(runs).toBe(0)
  fail = false
  click('re-enable')
  run(50)
  expect(runs).toBe(5)
  expect(text()).not.toContain('flaky')
})

test('errors raised while hidden are listed when the overlay opens', () => {
  vi.stubGlobal('location', { search: '' })
  const { engine, debug, run } = setup()
  engine.addSystem({
    name: 'broken',
    phase: 'update',
    update() {
      throw new Error('early')
    },
  })
  run(50)
  debug.visible = true
  expect(text()).toContain('broken disabled: Error: early')
})

test('actions become buttons, whether added before or after the overlay exists', () => {
  vi.stubGlobal('location', { search: '' })
  const { debug } = setup()
  const teleport = vi.fn()
  const reload = vi.fn()
  debug.addAction('teleport', teleport)
  debug.visible = true
  debug.addAction('reload', reload)
  click('teleport')
  click('reload')
  click('reload')
  expect(teleport).toHaveBeenCalledTimes(1)
  expect(reload).toHaveBeenCalledTimes(2)
})

test('installing twice throws', () => {
  const { engine, debug } = setup()
  expect(() => engine.use(debug)).toThrow('already installed')
})

test('dispose removes the element, the key listener and the systems', () => {
  const { engine, debug } = setup()
  debug.dispose()
  expect(body.children).toEqual([])
  expect(debug.visible).toBe(false)
  expect(removeEventListener).toHaveBeenCalledWith('keydown', keydown)
  // The names are free again.
  engine.addSystem({ name: 'debug:overlay', phase: 'render', update() {} })
  engine.addSystem({ name: 'debug:steps', phase: 'update', update() {} })
})
