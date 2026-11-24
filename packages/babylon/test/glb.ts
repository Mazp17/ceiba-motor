/**
 * A minimal valid binary glTF: one node, `marker`, holding a single triangle. `translation` is in glTF
 * space (right-handed); Babylon's loader mirrors X when it converts to the left-handed scene.
 */
export function makeGlb(translation: [number, number, number]): Uint8Array<ArrayBuffer> {
  const bin = new Uint8Array(44) // 3 float32 positions + 3 uint16 indices, padded to 4 bytes
  new Float32Array(bin.buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0])
  new Uint16Array(bin.buffer, 36, 3).set([0, 1, 2])
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'marker', mesh: 0, translation }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    buffers: [{ byteLength: bin.length }],
  }
  let text = JSON.stringify(gltf)
  text += ' '.repeat((4 - (text.length % 4)) % 4)
  const json = new TextEncoder().encode(text)
  const glb = new Uint8Array(12 + 8 + json.length + 8 + bin.length)
  const view = new DataView(glb.buffer)
  view.setUint32(0, 0x46546c67, true) // 'glTF'
  view.setUint32(4, 2, true)
  view.setUint32(8, glb.length, true)
  view.setUint32(12, json.length, true)
  view.setUint32(16, 0x4e4f534a, true) // 'JSON'
  glb.set(json, 20)
  view.setUint32(20 + json.length, bin.length, true)
  view.setUint32(24 + json.length, 0x004e4942, true) // 'BIN'
  glb.set(bin, 28 + json.length)
  return glb
}
