import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '@babylonjs/core/scene.js'
import { createEngine } from '@ceiba/core'
import type { ManifestChunk, WorldManifest } from '@ceiba/streaming'
import { afterEach, expect, test, vi } from 'vitest'
import { createChunkLoader } from '../src/chunkLoader.ts'
import { streamingPlugin } from '../src/streaming.ts'
import { makeGlb } from './glb.ts'

const MANIFEST_URL = 'https://cdn.test/world/v1/manifest.json'
// glTF (-10, 0, 10) is scene (10, 0, 10): the loader mirrors X. Where the generator puts its marker post.
const glb = makeGlb([-10, 0, 10])
const chunk = (cx: number, hash = 'a'): ManifestChunk => {
  return { cx, cz: 0, url: `chunks/${cx}_0.glb`, hash, gpuBytes: 1000, ramBytes: 1000 }
}
const manifest: WorldManifest = { version: 1, chunkSize: 100, chunks: [0, 1, 2, 3, 4, 5].map((cx) => chunk(cx)) }

// Chunk 2 has no lod: it only ever shows in full detail.
const withLod: WorldManifest = {
  ...manifest,
  chunks: manifest.chunks.map((c) => (c.cx === 2 ? c : { ...c, lod: { ...c, url: `chunks/${c.cx}_0.lod.glb` } })),
}
let served = manifest

const live = new AbortController().signal
const newScene = () => new Scene(new NullEngine())
/** What a chunk adds to a scene. All zero means nothing is left. */
const contents = (scene: Scene) => {
  // Babylon creates one BRDF lookup texture per scene for PBR materials; it is not the chunk's.
  const textures = scene.textures.filter((texture) => texture !== scene.environmentBRDFTexture)
  return [scene.transformNodes, scene.meshes, scene.geometries, scene.materials, textures].map((a) => a.length)
}
/** Scene position of the marker of a chunk, from a fresh world matrix. */
const marker = (scene: Scene, key: string) => {
  const mesh = scene.getTransformNodeByName(`chunk:${key}`)?.getChildMeshes(false, (node) => node.name === 'marker')[0]
  return mesh?.computeWorldMatrix(true).getTranslation().asArray()
}

function stubFetch() {
  const fetched: string[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    init?.signal?.throwIfAborted()
    fetched.push(url)
    if (url.endsWith('missing.glb')) return new Response(null, { status: 404 })
    return url.endsWith('.json') ? Response.json(served) : new Response(glb.slice())
  }
  vi.stubGlobal('fetch', fetch)
  return fetched
}

afterEach(() => {
  vi.unstubAllGlobals()
  served = manifest
})

test('decode hangs the chunk from one root, placed by the caller, and unload frees everything', async () => {
  stubFetch()
  const scene = newScene()
  const loader = createChunkLoader(scene, MANIFEST_URL, ({ root }) => root.position.set(300, 0, -200))
  const bytes = await loader.request(chunk(3), live)
  const { handle, gpuBytes, ramBytes } = await loader.decode(bytes, chunk(3), live)

  expect(handle.root.name).toBe('chunk:3,0')
  expect(scene.transformNodes).toContain(handle.root)
  expect(scene.rootNodes).toEqual([handle.root])
  expect(contents(scene)).toEqual([1, 2, 1, 1, 0]) // root; the loader's __root__ and the marker; its geometry and material
  expect(marker(scene, '3,0')).toEqual([310, 0, -190])
  expect([gpuBytes, ramBytes]).toEqual([36 + 6, glb.byteLength]) // 3 float32 positions + 3 uint16 indices
  expect([...loader.handles]).toEqual([handle])

  loader.unload(handle)
  expect(contents(scene)).toEqual([0, 0, 0, 0, 0])
  expect(handle.root.isDisposed()).toBe(true)
  expect(loader.handles.size).toBe(0)
})

test('chunk URLs resolve against the manifest URL; a failed download rejects', async () => {
  const fetched = stubFetch()
  const loader = createChunkLoader(newScene(), MANIFEST_URL, () => {})
  await loader.request(chunk(2), live)
  await loader.request({ ...chunk(2), url: '../shared/a.glb' }, live)
  await loader.request({ ...chunk(2), url: 'https://other.test/b.glb' }, live)
  expect(fetched).toEqual([
    'https://cdn.test/world/v1/chunks/2_0.glb',
    'https://cdn.test/world/shared/a.glb',
    'https://other.test/b.glb',
  ])
  await expect(loader.request({ ...chunk(2), url: 'missing.glb' }, live)).rejects.toThrow('HTTP 404')
})

test('abort during request or during decode leaves nothing behind', async () => {
  const fetched = stubFetch()
  const scene = newScene()
  const loader = createChunkLoader(scene, MANIFEST_URL, () => {})

  const early = new AbortController()
  early.abort()
  await expect(loader.request(chunk(0), early.signal)).rejects.toThrow('aborted')
  expect(fetched).toEqual([]) // the signal reached fetch

  const late = new AbortController()
  const decoding = loader.decode(glb.slice(), chunk(0), late.signal)
  late.abort()
  await expect(decoding).rejects.toThrow('aborted')
  expect(contents(scene)).toEqual([0, 0, 0, 0, 0])
  expect(loader.handles.size).toBe(0)
})

test('the cache serves a chunk until its hash changes, and keeps one entry per chunk', async () => {
  const fetched = stubFetch()
  const entries = new Map<string, Response>()
  const cache = {
    match: async (url: string) => entries.get(url)?.clone(),
    put: async (url: string, response: Response) => void entries.set(url, response),
  }
  vi.stubGlobal('caches', { open: async () => cache })
  const loader = createChunkLoader(newScene(), MANIFEST_URL, () => {})

  expect(await loader.request(chunk(1, 'a'), live)).toEqual(glb)
  await vi.waitFor(() => expect(entries.size).toBe(1))
  expect(await loader.request(chunk(1, 'a'), live)).toEqual(glb) // hit
  expect(fetched.length).toBe(1)
  await loader.request(chunk(1, 'b'), live) // miss: the hash changed
  expect(fetched.length).toBe(2)
  await vi.waitFor(() => expect(entries.get(fetched[0] as string)?.headers.get('x-ceiba-hash')).toBe('b'))
  expect(entries.size).toBe(1)
})

test('a Cache API that throws falls back to plain fetch', async () => {
  const fetched = stubFetch()
  const broken = { open: () => Promise.reject(new Error('SecurityError')) }
  vi.stubGlobal('caches', broken)
  expect(await createChunkLoader(newScene(), MANIFEST_URL, () => {}).request(chunk(1), live)).toEqual(glb)
  const failing = { match: () => Promise.reject(new Error('gone')), put: () => Promise.reject(new Error('quota')) }
  vi.stubGlobal('caches', { open: async () => failing })
  expect(await createChunkLoader(newScene(), MANIFEST_URL, () => {}).request(chunk(1), live)).toEqual(glb)
  expect(fetched.length).toBe(2)
})

async function installPlugin(lod?: { loadRadius: number; unloadRadius: number }) {
  const fetched = stubFetch()
  const scene = newScene()
  const core = createEngine({ fixedDt: 0.01, logLevel: 'silent' })
  const focus = { x: 50, z: 50 }
  const read = vi.fn(() => focus)
  const plugin = streamingPlugin({
    scene,
    manifestUrl: MANIFEST_URL,
    focus: read,
    gpuBudget: 1e6,
    ramBudget: 1e6,
    loadRadius: 1,
    unloadRadius: 2,
    ...(lod && { lod: { ...lod, gpuBudget: 1e6, ramBudget: 1e6 } }),
  })
  await core.use(plugin)
  let now = 0
  core.tick(now)
  const step = () => {
    now += 15 // one fixed step
    core.tick(now)
  }
  /** Scene x of every chunk root, sorted, once nothing is loading and at least one is in. */
  const roots = () => {
    return vi.waitFor(() => {
      step()
      const { chunks } = plugin.streamer.snapshot()
      expect(chunks.length > 0 && chunks.every((c) => c.state === 'ready')).toBe(true)
      const top = scene.transformNodes.filter((node) => !node.parent)
      return top.map((root) => root.position.x).sort((a, b) => a - b)
    })
  }
  return { fetched, scene, core, focus, read, plugin, step, roots }
}

test('the plugin fetches the manifest and loads the chunks around the focus at their corners', async () => {
  const { fetched, scene, core, plugin, roots } = await installPlugin()
  const states: string[] = []
  core.events.on('streaming:chunkState', ({ chunk, state }) => states.push(`${chunk.cx}:${state}`))
  expect(await roots()).toEqual([0, 100]) // chunks 0 and 1; there is no chunk -1
  expect(fetched.slice(0, 2)).toEqual([MANIFEST_URL, 'https://cdn.test/world/v1/chunks/0_0.glb'])
  expect(states).toEqual(expect.arrayContaining(['0:requesting', '0:decoding', '0:ready', '1:ready']))
  expect(plugin.streamer.origin).toEqual({ cx: 0, cz: 0 })
  expect(marker(scene, '1,0')).toEqual([110, 0, 10]) // corner of chunk 1 + (10, 0, 10)
})

test('an origin shift moves every root and emits the delta and the new origin', async () => {
  const { core, focus, plugin, roots } = await installPlugin()
  await roots()
  const shifts: unknown[] = []
  core.events.on('streaming:originShift', (shift) => {
    shifts.push(shift)
    focus.x += shift.delta.x // the game moves what it owns
    focus.z += shift.delta.z
  })
  focus.x = 350 // chunk 3: three chunks from the origin, past the threshold of 2
  // Chunk 0 is unloaded (too far), chunk 1 is kept and moves, chunks 2, 3 and 4 load around the new origin.
  expect(await roots()).toEqual([-200, -100, 0, 100])
  expect(shifts).toEqual([{ delta: { x: -300, z: 0 }, origin: { cx: 3, cz: 0 } }])
  expect(plugin.streamer.origin).toEqual({ cx: 3, cz: 0 })
  expect(focus).toEqual({ x: 50, z: 50 })
})

test('lod chunks fill a wider ring, hidden while their full detail is in the scene', async () => {
  served = withLod
  const { scene, core, focus, plugin, roots, step } = await installPlugin({ loadRadius: 3, unloadRadius: 4 })
  core.events.on('streaming:originShift', ({ delta }) => {
    focus.x += delta.x
  })
  /** `<cx>` of every visible root, by kind, once the lod ring has `count` chunks. */
  const shown = async (count: number) => {
    await roots()
    return vi.waitFor(() => {
      step()
      const all = scene.transformNodes.filter((node) => !node.parent)
      expect(all.filter((node) => node.name.startsWith('lod:'))).toHaveLength(count)
      return all
        .filter((node) => node.isEnabled())
        .map((node) => node.name.replace(',0', ''))
        .sort()
    })
  }
  // Focus in chunk 0: detail for 0 and 1, low detail for 0, 1 and 3 (chunk 2 has none); 0 and 1 are covered.
  expect(await shown(3)).toEqual(['chunk:0', 'chunk:1', 'lod:3'])
  // Focus in chunk 3 (the origin shifts): detail for 2, 3 and 4; chunk 1 falls back to its low detail.
  focus.x = 350
  expect(await shown(5)).toEqual(['chunk:1', 'chunk:2', 'chunk:3', 'chunk:4', 'lod:0', 'lod:5'])
  expect(plugin.streamer.origin).toEqual({ cx: 3, cz: 0 })
  const x = (name: string) => scene.getTransformNodeByName(name)?.position.x
  expect([x('lod:0,0'), x('lod:5,0'), x('chunk:3,0')]).toEqual([-300, 200, 0])
  await plugin.dispose()
  expect(contents(scene)).toEqual([0, 0, 0, 0, 0])
})

test('overBudget is emitted when it changes', async () => {
  const fetched = stubFetch()
  const core = createEngine({ fixedDt: 0.01, logLevel: 'silent' })
  const events: boolean[] = []
  core.events.on('streaming:overBudget', ({ overBudget }) => events.push(overBudget))
  const options = { scene: newScene(), manifestUrl: MANIFEST_URL, focus: () => ({ x: 50, z: 50 }), ramBudget: 1e6 }
  await core.use(streamingPlugin({ ...options, gpuBudget: 500 })) // a chunk reserves 1000
  core.tick(0)
  core.tick(15)
  core.tick(30)
  expect(events).toEqual([true])
  expect(fetched).toEqual([MANIFEST_URL])
})

test('dispose stops the system and unloads everything; the plugin installs again', async () => {
  const { scene, read, plugin, roots, step, core } = await installPlugin()
  await roots()
  await plugin.dispose()
  expect(contents(scene)).toEqual([0, 0, 0, 0, 0])
  read.mockClear()
  step()
  expect(read).not.toHaveBeenCalled()
  expect(() => plugin.streamer).toThrow('not installed')
  await plugin.dispose() // no-op
  await core.use(plugin)
  await expect(core.use(plugin)).rejects.toThrow('already installed')
  expect(await roots()).toEqual([0, 100])
})

test('install rejects on a missing or invalid manifest', async () => {
  const options = { scene: newScene(), focus: () => ({ x: 0, z: 0 }), gpuBudget: 1, ramBudget: 1 }
  const core = createEngine({ logLevel: 'silent' })
  vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }))
  await expect(core.use(streamingPlugin({ ...options, manifestUrl: MANIFEST_URL }))).rejects.toThrow('HTTP 404')
  vi.stubGlobal('fetch', async () => Response.json({ version: 2 }))
  await expect(core.use(streamingPlugin({ ...options, manifestUrl: MANIFEST_URL }))).rejects.toThrow(
    'invalid world manifest',
  )
})
