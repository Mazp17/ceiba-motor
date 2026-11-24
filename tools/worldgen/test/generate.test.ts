import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { Scene } from '@babylonjs/core/scene.js'
import '@babylonjs/loaders/glTF/2.0/index.js'
import { NodeIO } from '@gltf-transform/core'
import { afterAll, expect, test } from 'vitest'
import { validateManifest } from '../../../packages/streaming/src/index.ts'
import { buildChunk, generateWorld, isHole, MARKER, MARKER_COLOR } from '../src/generate.ts'

const OPTIONS = { size: 8, chunkSize: 256, seed: 7 }
const EPSILON = 1e-3

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true })
})

async function world(options = OPTIONS) {
  const dir = mkdtempSync(join(tmpdir(), 'worldgen-'))
  dirs.push(dir)
  return { dir, manifest: await generateWorld(dir, options) }
}

/** Every file of a generated world, by relative path. */
function files(dir: string): Record<string, string> {
  const paths = (readdirSync(dir, { recursive: true }) as string[]).filter((path) => path.includes('.')).sort()
  return Object.fromEntries(paths.map((path) => [path, readFileSync(join(dir, path)).toString('base64')]))
}

interface Vertex {
  position: number[]
  normal: number[]
  color: number[]
}

/** Vertices and triangles of a chunk file, in the frame Babylon's loader leaves them in: x mirrored. */
async function converted(glb: Uint8Array) {
  const document = await new NodeIO().readBinary(glb)
  const primitive = document.getRoot().listMeshes()[0]?.listPrimitives()[0]
  const read = (name: string) => primitive?.getAttribute(name)?.getArray() ?? []
  const [positions, normals, colors] = [read('POSITION'), read('NORMAL'), read('COLOR_0')]
  const indices = [...(primitive?.getIndices()?.getArray() ?? [])]
  const vertices: Vertex[] = []
  for (let i = 0; i < positions.length; i += 3) {
    vertices.push({
      position: [-(positions[i] ?? 0), positions[i + 1] ?? 0, positions[i + 2] ?? 0],
      normal: [-(normals[i] ?? 0), normals[i + 1] ?? 0, normals[i + 2] ?? 0],
      color: [...colors.slice(i, i + 3)],
    })
  }
  return { vertices, indices }
}

/** Sign of ((b - a) x (c - a)) . normal for each triangle. */
function windings(vertices: Vertex[], indices: number[]): number[] {
  const signs: number[] = []
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.slice(i, i + 3).map((index) => vertices[index] as Vertex) as [Vertex, Vertex, Vertex]
    const u = Vector3.FromArray(b.position).subtract(Vector3.FromArray(a.position))
    const v = Vector3.FromArray(c.position).subtract(Vector3.FromArray(a.position))
    signs.push(Math.sign(Vector3.Dot(Vector3.Cross(u, v), Vector3.FromArray(a.normal))))
  }
  return signs
}

test('same options give byte-identical output, another seed does not', async () => {
  const [a, b, c] = await Promise.all([world(), world(), world({ ...OPTIONS, seed: 8 })])
  expect(files(a.dir)).toEqual(files(b.dir))
  expect(files(a.dir)).not.toEqual(files(c.dir))
})

test('the manifest validates and its hashes match the files', async () => {
  const { dir, manifest } = await world()
  expect(validateManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))).toEqual(manifest)
  expect(manifest.chunkSize).toBe(256)
  for (const chunk of manifest.chunks) {
    const glb = readFileSync(join(dir, chunk.url))
    expect(chunk.hash).toBe(createHash('sha256').update(glb).digest('hex').slice(0, 16))
    expect(chunk.ramBytes).toBe(chunk.gpuBytes + glb.byteLength)
  }
})

test('holes are absent from the manifest and from disk, and density varies', async () => {
  const { dir, manifest } = await world()
  const listed = new Set(manifest.chunks.map((chunk) => `${chunk.cx}_${chunk.cz}`))
  let holes = 0
  for (let cz = -4; cz < 4; cz++) {
    for (let cx = -4; cx < 4; cx++) {
      const hole = isHole(cx, cz, OPTIONS.seed)
      if (hole) holes++
      expect(listed.has(`${cx}_${cz}`)).toBe(!hole)
      expect(existsSync(join(dir, `chunks/${cx}_${cz}.glb`))).toBe(!hole)
    }
  }
  expect(holes).toBeGreaterThan(0)
  expect(listed.has('0_0')).toBe(true)
  expect(readdirSync(join(dir, 'chunks'))).toHaveLength(manifest.chunks.length)

  const sizes = manifest.chunks.map((chunk) => chunk.gpuBytes)
  expect(Math.max(...sizes)).toBeGreaterThan(5 * Math.min(...sizes))
})

test('every chunk, converted the way Babylon does, fits its frame, faces outwards and has the marker', async () => {
  const { dir, manifest } = await world()
  for (const chunk of manifest.chunks) {
    const { vertices, indices } = await converted(readFileSync(join(dir, chunk.url)))
    for (const { position } of vertices) {
      expect(position[0]).toBeGreaterThanOrEqual(0)
      expect(position[0]).toBeLessThanOrEqual(manifest.chunkSize + EPSILON)
      expect(position[2]).toBeGreaterThanOrEqual(0)
      expect(position[2]).toBeLessThanOrEqual(manifest.chunkSize + EPSILON)
      expect(position[1]).toBeGreaterThanOrEqual(0)
    }
    // The ground spans the whole chunk and faces up.
    expect(vertices.slice(0, 4).map((vertex) => vertex.position)).toEqual([[0, 0, 0], [256, 0, 0], [256, 0, 256], [0, 0, 256]]) // biome-ignore format: one line
    expect(vertices[0]?.normal).toEqual([0, 1, 0])

    // glTF data is counter-clockwise about its normals; mirrored, every triangle is clockwise about them.
    expect(new Set(windings(vertices, indices))).toEqual(new Set([-1]))

    const marker = vertices.filter((vertex) => vertex.color.every((value, i) => value === MARKER_COLOR[i]))
    const xs = marker.map((vertex) => vertex.position[0] ?? 0)
    const zs = marker.map((vertex) => vertex.position[2] ?? 0)
    // The post stands on (10, _, 10) and its arm points along +x only.
    const foot = marker.filter((vertex) => vertex.position[1] === 0)
    expect([Math.min(...foot.map((v) => v.position[0] ?? 0)), Math.max(...foot.map((v) => v.position[0] ?? 0))]).toEqual([MARKER.x - 0.5, MARKER.x + 0.5]) // biome-ignore format: one line
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([MARKER.x - 0.5, MARKER.x + 6])
    expect([Math.min(...zs), Math.max(...zs)]).toEqual([MARKER.z - 0.5, MARKER.z + 0.5])
    expect(Math.max(...marker.map((vertex) => vertex.position[1] ?? 0))).toBe(MARKER.height)
    // Normals point away from the post's axis.
    for (const { position, normal } of foot) {
      if (normal[0]) expect(normal[0]).toBe(Math.sign((position[0] ?? 0) - MARKER.x))
      if (normal[2]) expect(normal[2]).toBe(Math.sign((position[2] ?? 0) - MARKER.z))
    }
  }
})

test('a chunk loaded by Babylon into a left-handed scene meets the frame contract', async () => {
  const { glb, gpuBytes } = await buildChunk(0, 0, OPTIONS)
  const scene = new Scene(new NullEngine())
  expect(scene.useRightHandedSystem).toBe(false)
  const container = await LoadAssetContainerAsync(glb, scene, { pluginExtension: '.glb' })
  const mesh = container.meshes.find((candidate) => candidate.getTotalVertices() > 0) as Mesh
  const matrix = mesh.computeWorldMatrix(true)

  /** Vertices and windings in scene space, plus the side orientation Babylon draws the mesh with. */
  const inScene = (target: Mesh) => {
    const world = target.computeWorldMatrix(true)
    const positions = target.getVerticesData('position') ?? []
    const normals = target.getVerticesData('normal') ?? []
    const vertices: Vertex[] = []
    for (let i = 0; i < positions.length; i += 3) {
      vertices.push({
        position: Vector3.TransformCoordinates(Vector3.FromArray(positions, i), world).asArray(),
        normal: Vector3.TransformNormal(Vector3.FromArray(normals, i), world).asArray(),
        color: [],
      })
    }
    // Internal, but it is the value the draw call culls with: mesh orientation, flipped when the world matrix mirrors.
    const orientation = target._getDrawSideOrientation(target.material ?? new StandardMaterial('', scene))
    return { vertices, signs: new Set(windings(vertices, [...(target.getIndices() ?? [])])), orientation }
  }

  // Babylon's result equals the x mirror the generator compensates for.
  const loaded = inScene(mesh)
  const expected = await converted(glb)
  expect(matrix.determinant()).toBeLessThan(0)
  expect(loaded.vertices).toHaveLength(expected.vertices.length)
  for (const [i, vertex] of loaded.vertices.entries()) {
    for (const axis of [0, 1, 2]) {
      expect(vertex.position[axis]).toBeCloseTo(expected.vertices[i]?.position[axis] ?? Number.NaN, 3)
      expect(vertex.normal[axis]).toBeCloseTo(expected.vertices[i]?.normal[axis] ?? Number.NaN, 5)
    }
  }
  const xs = loaded.vertices.map((vertex) => vertex.position[0] ?? 0)
  const zs = loaded.vertices.map((vertex) => vertex.position[2] ?? 0)
  expect([Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]).toEqual([0, 256, 0, 256])

  // Faces are not inside-out: winding and draw orientation relate the way they do on a box Babylon builds itself.
  const box = inScene(CreateBox('reference', {}, scene))
  expect(loaded.signs.size).toBe(1)
  expect(box.signs.size).toBe(1)
  expect(loaded.signs.has(1) === box.signs.has(1)).toBe(loaded.orientation === box.orientation)

  // The manifest estimate is what Babylon holds for the mesh.
  const held = ['position', 'normal', 'color'].reduce(
    (sum, kind) => sum + (mesh.getVerticesData(kind)?.length ?? 0) * 4,
    0,
  )
  expect(gpuBytes).toBe(held + (mesh.getIndices() as Uint16Array).byteLength)
})
