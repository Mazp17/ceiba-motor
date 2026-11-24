import { expect, test } from 'vitest'
import { lodManifest, validateManifest } from '../src/index.ts'

const chunk = { cx: 0, cz: -1, url: 'chunks/0_-1.glb', hash: 'a1b2', gpuBytes: 1000, ramBytes: 500 }
const lod = { url: 'chunks/1_-1.lod.glb', hash: 'c3', gpuBytes: 100, ramBytes: 50 }
const manifest = { version: 1, chunkSize: 256, chunks: [chunk, { ...chunk, cx: 1, lod }] }

test('a well-formed manifest is returned as is', () => {
  expect(validateManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest)
})

test.each([
  ['not an object', null],
  ['version must be 1', { ...manifest, version: 2 }],
  ['chunkSize must be a positive number', { ...manifest, chunkSize: 0 }],
  ['chunks must be an array', { ...manifest, chunks: {} }],
  ['chunks[0] is not an object', { ...manifest, chunks: [null] }],
  ['chunks[0]: cx and cz must be integers', { ...manifest, chunks: [{ ...chunk, cx: 0.5 }] }],
  ['chunks[0]: url must be a non-empty string', { ...manifest, chunks: [{ ...chunk, url: '' }] }],
  ['chunks[0]: hash must be a non-empty string', { ...manifest, chunks: [{ ...chunk, hash: undefined }] }],
  ['chunks[0]: gpuBytes and ramBytes must be numbers >= 0', { ...manifest, chunks: [{ ...chunk, ramBytes: -1 }] }],
  ['chunks[0].lod is not an object', { ...manifest, chunks: [{ ...chunk, lod: 'a.glb' }] }],
  [
    'chunks[0].lod: hash must be a non-empty string',
    { ...manifest, chunks: [{ ...chunk, lod: { ...lod, hash: '' } }] },
  ],
  ['chunks[1]: duplicate chunk 0,-1', { ...manifest, chunks: [chunk, chunk] }],
])('rejects: %s', (message, data) => {
  expect(() => validateManifest(data)).toThrow(`invalid world manifest: ${message}`)
})

test('lodManifest keeps only the chunks with a lod, as their lod asset', () => {
  expect(lodManifest(validateManifest(manifest)).chunks).toEqual([{ cx: 1, cz: -1, ...lod }])
})
