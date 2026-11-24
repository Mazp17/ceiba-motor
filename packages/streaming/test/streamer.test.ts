import { expect, test } from 'vitest'
import {
  type ChunkState,
  chunkKey,
  chunkToScene,
  createStreamer,
  type ManifestChunk,
  type Streamer,
  type StreamerOptions,
  sceneToChunk,
  type WorldManifest,
} from '../src/index.ts'

const SIZE = 256
const MB = 1e6
const still = { x: 0, z: 0 }

/** A rectangular world where every chunk is estimated at 10 MB of GPU and 5 MB of RAM. */
function world(x0: number, x1: number, z0 = 0, z1 = 0): WorldManifest {
  const chunks: ManifestChunk[] = []
  for (let cz = z0; cz <= z1; cz++)
    for (let cx = x0; cx <= x1; cx++)
      chunks.push({ cx, cz, url: `${cx}_${cz}.glb`, hash: 'h', gpuBytes: 10 * MB, ramBytes: 5 * MB })
  return { version: 1, chunkSize: SIZE, chunks }
}

/**
 * Loader on a manual clock: `request` and `decode` settle when `advance` reaches their latency.
 * It ignores the abort signal on purpose, the worst case the streamer has to cope with.
 */
function fakeLoader(requestMs = 1, decodeMs = 1) {
  let now = 0
  let jobs: { due: number; fire: () => void }[] = []
  const wait = (ms: number) => new Promise<void>((fire) => jobs.push({ due: now + ms, fire }))
  const loader = {
    live: new Set<object>(),
    requested: [] as string[],
    decoded: [] as string[],
    unloaded: [] as string[],
    signals: [] as AbortSignal[],
    fail: new Set<string>(),
    /** Measured size as a multiple of the manifest estimate. */
    scale: 1,
    async request(chunk: ManifestChunk, signal: AbortSignal) {
      loader.requested.push(chunkKey(chunk))
      loader.signals.push(signal)
      await wait(requestMs)
      if (loader.fail.has(chunkKey(chunk))) throw new Error('offline')
      return chunkKey(chunk)
    },
    async decode(key: string, chunk: ManifestChunk) {
      loader.decoded.push(key)
      await wait(decodeMs)
      const handle = { key }
      loader.live.add(handle)
      return { gpuBytes: chunk.gpuBytes * loader.scale, ramBytes: chunk.ramBytes * loader.scale, handle }
    },
    unload(handle: { key: string }) {
      loader.live.delete(handle)
      loader.unloaded.push(handle.key)
    },
    /** Moves the clock, settles what is due and lets the streamer react. */
    async advance(ms = 1) {
      now += ms
      const due = jobs.filter((job) => job.due <= now)
      jobs = jobs.filter((job) => job.due > now)
      for (const job of due) job.fire()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    },
  }
  return loader
}

type Loader = ReturnType<typeof fakeLoader>

function make(
  manifest: WorldManifest,
  loader: Loader,
  options: Partial<StreamerOptions<{ key: string }, string>> = {},
) {
  return createStreamer({ manifest, loader, gpuBudget: Infinity, ramBudget: Infinity, ...options })
}

/** Centre of a chunk in the streamer's current scene frame. */
function at(streamer: Streamer, cx: number, cz = 0) {
  const corner = chunkToScene({ cx, cz }, streamer.origin, SIZE)
  return { x: corner.x + SIZE / 2, z: corner.z + SIZE / 2 }
}

/** Parks the focus on a chunk long enough for everything to settle. */
async function visit(streamer: Streamer, loader: Loader, cx: number, cz = 0) {
  for (let i = 0; i < 12; i++) {
    streamer.update({ position: at(streamer, cx, cz), velocity: still })
    await loader.advance()
  }
}

const states = (streamer: Streamer) =>
  Object.fromEntries(streamer.snapshot().chunks.map((chunk) => [chunkKey(chunk), chunk.state]))
const inState = (streamer: Streamer, ...wanted: ChunkState[]) =>
  streamer.snapshot().chunks.filter((chunk) => wanted.includes(chunk.state)).length

test('a chunk goes through the whole lifecycle and back to unloaded', async () => {
  const loader = fakeLoader()
  const seen: string[] = []
  const streamer = make(world(0, 0), loader, {
    loadRadius: 0,
    unloadRadius: 1,
    onStateChange: (chunk, state, previous) => seen.push(`${chunkKey(chunk)} ${previous}>${state}`),
  })
  expect(states(streamer)).toEqual({})

  streamer.update({ position: at(streamer, 0), velocity: still })
  expect(states(streamer)).toEqual({ '0,0': 'requesting' })
  await loader.advance()
  expect(states(streamer)).toEqual({ '0,0': 'decoding' })
  await loader.advance()
  expect(states(streamer)).toEqual({ '0,0': 'ready' })
  expect(streamer.snapshot()).toMatchObject({ gpuBytes: 10 * MB, ramBytes: 5 * MB, overBudget: false })

  streamer.update({ position: at(streamer, 5), velocity: still })
  expect(states(streamer)).toEqual({ '0,0': 'unloading' })
  expect(streamer.snapshot().gpuBytes).toBe(10 * MB) // still held until the unload settles
  await loader.advance()
  expect(states(streamer)).toEqual({})
  expect(loader.live.size).toBe(0)
  expect(seen).toEqual([
    '0,0 unloaded>requesting',
    '0,0 requesting>decoding',
    '0,0 decoding>ready',
    '0,0 ready>unloading',
    '0,0 unloading>unloaded',
  ])
})

test('a chunk cancelled while requesting is aborted, never decoded and frees its slot', async () => {
  const loader = fakeLoader()
  const seen: ChunkState[] = []
  const streamer = make(world(0, 0), loader, {
    loadRadius: 0,
    unloadRadius: 1,
    onStateChange: (_, state) => seen.push(state),
  })
  streamer.update({ position: at(streamer, 0), velocity: still })
  streamer.update({ position: at(streamer, 5), velocity: still })
  expect(states(streamer)).toEqual({})
  expect(loader.signals[0]?.aborted).toBe(true)
  expect(streamer.snapshot().gpuBytes).toBe(0)
  await loader.advance(5)
  expect(loader.decoded).toEqual([])
  expect(seen).toEqual(['requesting', 'unloaded'])
})

test('a chunk cancelled while decoding never becomes ready and its late result is unloaded', async () => {
  const loader = fakeLoader()
  const seen: ChunkState[] = []
  const streamer = make(world(0, 0), loader, {
    loadRadius: 0,
    unloadRadius: 1,
    onStateChange: (_, state) => seen.push(state),
  })
  streamer.update({ position: at(streamer, 0), velocity: still })
  await loader.advance()
  streamer.update({ position: at(streamer, 5), velocity: still })
  expect(states(streamer)).toEqual({})
  await loader.advance() // the loader finishes the decode anyway
  expect(loader.unloaded).toEqual(['0,0'])
  expect(loader.live.size).toBe(0)
  expect(seen).toEqual(['requesting', 'decoding', 'unloaded'])
})

test('a chunk wanted again after a cancel loads once, ignoring the stale request', async () => {
  const loader = fakeLoader(3, 1)
  const seen: ChunkState[] = []
  const streamer = make(world(0, 0), loader, {
    loadRadius: 0,
    unloadRadius: 1,
    onStateChange: (_, state) => seen.push(state),
  })
  streamer.update({ position: at(streamer, 0), velocity: still })
  streamer.update({ position: at(streamer, 5), velocity: still })
  await loader.advance()
  streamer.update({ position: at(streamer, 0), velocity: still })
  await loader.advance(2) // the stale request settles here
  expect(states(streamer)).toEqual({ '0,0': 'requesting' })
  await loader.advance(1)
  await loader.advance(1)
  expect(states(streamer)).toEqual({ '0,0': 'ready' })
  expect(loader.requested).toEqual(['0,0', '0,0'])
  expect(loader.live.size).toBe(1)
  expect(seen).toEqual(['requesting', 'unloaded', 'requesting', 'decoding', 'ready'])
})

test('a failed load is reported, holds no memory and is not retried until the chunk is dropped', async () => {
  const loader = fakeLoader()
  const errors: string[] = []
  const streamer = make(world(0, 0), loader, {
    loadRadius: 0,
    unloadRadius: 1,
    onError: (chunk, error) => errors.push(`${chunkKey(chunk)} ${(error as Error).message}`),
  })
  loader.fail.add('0,0')
  await visit(streamer, loader, 0)
  expect(states(streamer)).toEqual({ '0,0': 'failed' })
  expect(errors).toEqual(['0,0 offline'])
  expect(loader.requested).toHaveLength(1)
  expect(streamer.snapshot().gpuBytes).toBe(0)

  loader.fail.clear()
  await visit(streamer, loader, 5)
  expect(states(streamer)).toEqual({})
  await visit(streamer, loader, 0)
  expect(states(streamer)).toEqual({ '0,0': 'ready' })
})

test('pending loads are ordered by distance when the focus is at rest', async () => {
  const loader = fakeLoader()
  const streamer = make(world(-3, 3, -3, 3), loader, { maxConcurrent: 1 })
  for (let i = 0; i < 60; i++) {
    streamer.update({ position: at(streamer, 0), velocity: still })
    await loader.advance()
  }
  expect(loader.requested).toHaveLength(25)
  expect(loader.requested[0]).toBe('0,0')
  expect(loader.requested.slice(1, 5).sort()).toEqual(['-1,0', '0,-1', '0,1', '1,0'])
  expect(loader.requested.slice(-4).sort()).toEqual(['-2,-2', '-2,2', '2,-2', '2,2'])
})

test('at 70 m/s the chunks ahead load before the ones behind', async () => {
  const loader = fakeLoader()
  const streamer = make(world(-3, 3, -3, 3), loader, { maxConcurrent: 1 })
  for (let i = 0; i < 60; i++) {
    streamer.update({ position: at(streamer, 0), velocity: { x: 70, z: 0 } })
    await loader.advance()
  }
  const order = (cx: number, cz: number) => loader.requested.indexOf(`${cx},${cz}`)
  expect(loader.requested).toHaveLength(25)
  expect(loader.requested.slice(0, 2)).toEqual(['0,0', '1,0'])
  for (let cz = -2; cz <= 2; cz++)
    for (const cx of [1, 2]) expect(order(cx, cz), `${cx},${cz}`).toBeLessThan(order(-cx, cz))
  expect(order(2, 0)).toBeLessThan(order(-1, 0))
  expect(loader.requested.slice(-2).sort()).toEqual(['-2,-2', '-2,2'])
})

test('no more than maxConcurrent chunks load at once', async () => {
  const loader = fakeLoader()
  const streamer = make(world(-3, 3, -3, 3), loader, { maxConcurrent: 3 })
  streamer.update({ position: at(streamer, 0), velocity: still })
  expect(inState(streamer, 'requesting', 'decoding')).toBe(3)
  for (let i = 0; i < 40; i++) {
    await loader.advance()
    streamer.update({ position: at(streamer, 0), velocity: still })
    expect(inState(streamer, 'requesting', 'decoding')).toBeLessThanOrEqual(3)
  }
  expect(inState(streamer, 'ready')).toBe(25)
})

test.each([
  ['GPU', { gpuBudget: 30 * MB }],
  ['RAM', { ramBudget: 15 * MB }],
])('over the %s budget, the least recently used chunk outside the load radius is evicted first', async (_, budget) => {
  const loader = fakeLoader()
  const streamer = make(world(0, 6), loader, { loadRadius: 0, unloadRadius: 3, ...budget })
  await visit(streamer, loader, 0)
  await visit(streamer, loader, 1)
  await visit(streamer, loader, 2)
  await visit(streamer, loader, 1) // makes chunk 1 more recent than chunk 2
  expect(loader.unloaded).toEqual([])

  await visit(streamer, loader, 3)
  expect(loader.unloaded).toEqual(['0,0'])
  await visit(streamer, loader, 4)
  expect(loader.unloaded).toEqual(['0,0', '2,0']) // not chunk 1, although it is farther away
  expect(states(streamer)).toEqual({ '1,0': 'ready', '3,0': 'ready', '4,0': 'ready' })
  expect(streamer.snapshot().overBudget).toBe(false)
})

test('when the load radius alone exceeds the budget, the nearest chunks load, the rest wait, nothing thrashes', async () => {
  const loader = fakeLoader()
  const streamer = make(world(-1, 1, -1, 1), loader, { loadRadius: 1, unloadRadius: 2, gpuBudget: 50 * MB })
  let result = streamer.update({ position: at(streamer, 0), velocity: still })
  expect(result.overBudget).toBe(false) // nothing was refused yet
  for (let i = 0; i < 100; i++) {
    await loader.advance()
    result = streamer.update({ position: at(streamer, 0), velocity: still })
    expect(streamer.snapshot().gpuBytes).toBeLessThanOrEqual(50 * MB)
  }
  expect(result.overBudget).toBe(true)
  expect(streamer.snapshot().overBudget).toBe(true)
  expect(states(streamer)).toEqual({ '0,0': 'ready', '-1,0': 'ready', '1,0': 'ready', '0,-1': 'ready', '0,1': 'ready' })
  expect(loader.requested).toHaveLength(5)
  expect(loader.unloaded).toEqual([])
})

test('measured sizes above the estimates are reported as over budget without evicting wanted chunks', async () => {
  const loader = fakeLoader()
  loader.scale = 2
  const streamer = make(world(-1, 1, -1, 1), loader, { loadRadius: 1, unloadRadius: 2, gpuBudget: 100 * MB })
  await visit(streamer, loader, 0)
  await visit(streamer, loader, 0)
  expect(streamer.snapshot().overBudget).toBe(true)
  expect(streamer.snapshot().gpuBytes).toBeGreaterThan(100 * MB)
  expect(new Set(loader.requested).size).toBe(loader.requested.length)
  expect(loader.unloaded).toEqual([])
})

test('a focus oscillating across a chunk border does not load and unload in a loop', async () => {
  const loader = fakeLoader()
  const streamer = make(world(-4, 5), loader, { loadRadius: 1, unloadRadius: 2 })
  for (let i = 0; i < 200; i++) {
    // 1 m to each side of the border between chunks 0 and 1.
    streamer.update({ position: { x: SIZE + (i % 2 ? 1 : -1), z: 10 }, velocity: still })
    await loader.advance()
  }
  expect(loader.requested.sort()).toEqual(['-1,0', '0,0', '1,0', '2,0'])
  expect(loader.unloaded).toEqual([])
  expect(inState(streamer, 'ready')).toBe(4)
})

test('unloadRadius must be greater than loadRadius', () => {
  expect(() => make(world(0, 0), fakeLoader(), { loadRadius: 2, unloadRadius: 2 })).toThrow('unloadRadius')
})

test('the streamer shifts the origin once and reports the delta, without reloading chunks', async () => {
  const loader = fakeLoader()
  const streamer = make(world(-4, 10), loader)
  const shifts: unknown[] = []
  const go = async (cx: number) => {
    shifts.push(streamer.update({ position: at(streamer, cx), velocity: still }).originShift)
    await visit(streamer, loader, cx)
  }
  await go(1)
  await go(2)
  expect(streamer.origin).toEqual({ cx: 0, cz: 0 })
  await go(3)
  expect(streamer.origin).toEqual({ cx: 3, cz: 0 })
  for (const cx of [2, 3, 2, 3]) await go(cx)
  expect(shifts).toEqual([null, null, { x: -3 * SIZE, z: 0 }, null, null, null, null])
  expect(streamer.origin).toEqual({ cx: 3, cz: 0 })
  expect(new Set(loader.requested).size).toBe(loader.requested.length)
})

test('dispose cancels loads, unloads everything and leaks nothing', async () => {
  const loader = fakeLoader()
  const streamer = make(world(-3, 3, -3, 3), loader)
  streamer.update({ position: at(streamer, 0), velocity: still })
  await loader.advance()
  await loader.advance()
  streamer.update({ position: at(streamer, 0), velocity: still })
  await loader.advance()
  expect(inState(streamer, 'ready')).toBe(4)
  expect(inState(streamer, 'decoding')).toBe(4)

  await streamer.dispose()
  expect(states(streamer)).toEqual({})
  await loader.advance(5) // the cancelled decodes finish late
  expect(loader.live.size).toBe(0)
  expect(streamer.snapshot()).toEqual({ gpuBytes: 0, ramBytes: 0, overBudget: false, chunks: [] })
})

test('scenario: 8 km in a straight line at 70 m/s', async () => {
  // Loader latency: 300 ms request + 200 ms decode per chunk, 4 at a time (the default).
  const loader = fakeLoader(300, 200)
  const budget = { gpuBudget: 350 * MB, ramBudget: 175 * MB } // 35 chunks; the load radius holds 25
  const streamer = make(world(-4, 36, -4, 4), loader, budget)
  const stepMs = 20
  const position = at(streamer, 0)
  const velocity = { x: 70, z: 0 }

  // Spawn: wait for the surroundings before driving off.
  for (let i = 0; i < 400; i++) {
    streamer.update({ position, velocity: still })
    await loader.advance(stepMs)
  }
  expect(inState(streamer, 'ready')).toBe(25)

  let shifts = 0
  for (let travelled = 0; travelled < 8000; travelled += (velocity.x * stepMs) / 1000) {
    position.x += (velocity.x * stepMs) / 1000
    const { originShift, overBudget } = streamer.update({ position, velocity })
    if (originShift) {
      position.x += originShift.x
      position.z += originShift.z
      shifts++
    }
    const snapshot = streamer.snapshot()
    const under = chunkKey(sceneToChunk(position, streamer.origin, SIZE))
    expect(states(streamer)[under], `chunk ${under} under the focus`).toBe('ready')
    expect(overBudget).toBe(false)
    expect(snapshot.gpuBytes).toBeLessThanOrEqual(budget.gpuBudget)
    expect(snapshot.ramBytes).toBeLessThanOrEqual(budget.ramBudget)
    expect(loader.live.size * 10 * MB).toBeLessThanOrEqual(budget.gpuBudget)
    expect(Math.abs(position.x)).toBeLessThan(4 * SIZE) // scene coordinates stay small
    await loader.advance(stepMs)
  }
  expect(sceneToChunk(position, streamer.origin, SIZE)).toEqual({ cx: 31, cz: 0 })
  expect(shifts).toBe(10)
  expect(new Set(loader.requested).size).toBe(loader.requested.length) // no chunk loaded twice

  await streamer.dispose()
  await loader.advance(1000)
  expect(loader.live.size).toBe(0)
  expect(streamer.snapshot().chunks).toEqual([])
})
