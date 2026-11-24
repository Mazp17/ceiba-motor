# pipeline

Turns one source `.glb` (a whole world exported from Blender) into the streaming format of
`@ceiba/streaming`: a `manifest.json` and, per chunk, a full-detail `.glb` and a low-detail
`.lod.glb`. Private tool, not published.

## Usage

```sh
pnpm run pipeline --in world.glb --out <dir> [--chunk-size 256]
node tools/pipeline/src/cli.ts --in world.glb --out <dir> [--chunk-size 256]
```

`pnpm pipeline` without `run` does not work: pnpm has a built-in command of that name.

| Option | Default | |
| --- | --- | --- |
| `--in` | required | Source `.glb` or `.gltf` |
| `--out` | required | Output directory. Its `chunks/` folder and `manifest.json` are replaced |
| `--chunk-size` | `256` | Side of a chunk, in metres |

Node 24 runs the TypeScript directly; there is no build step.

## Input contract

- One glTF scene (the default one), y up, metres: what Blender's glTF exporter writes.
- The chunk grid is laid over the world as Babylon shows the source file. Babylon's glTF loader
  mirrors x when it loads into its left-handed scene, so scene x is minus glTF x, which is minus
  Blender x; scene z is glTF z, which is minus Blender y. Chunk `(cx, cz)` covers scene x in
  `[cx, cx + 1) * chunkSize` and z in `[cz, cz + 1) * chunkSize`.
- Every node with a mesh is one unit: it goes, whole, to the chunk that holds the centre of its
  bounding box. Its world transform is baked into the chunk file and its name and `extras` (Blender
  custom properties) are kept. The rest of the hierarchy is flattened away.
- Textures are PNG, JPEG or WebP.

## Output

- `chunks/<cx>_<cz>.glb`: the chunk in chunk-local coordinates, following the chunk frame contract
  of `tools/worldgen/README.md`: loaded by Babylon it spans x and z in `[0, chunkSize]` with the
  chunk's minimum corner at the origin.
- `chunks/<cx>_<cz>.lod.glb`: the same chunk simplified with meshoptimizer to about 10% of its
  vertices (it stops earlier where that would move the surface more than 5% of the mesh radius),
  textures at most 256 px on their longest side.
- Both are quantized (`KHR_mesh_quantization`) and compressed with Meshopt
  (`EXT_meshopt_compression`). To load them the game passes a decoder to `streamingPlugin` of
  `@ceiba/babylon`: see its README.
- `manifest.json`: a `WorldManifest`, checked with `validateManifest`. Chunks with no content are
  not listed. `url` is relative to the manifest and `hash` is the first 16 hex digits of the file's
  SHA-256. `gpuBytes` and `ramBytes` estimate memory after decoding, not download size: `gpuBytes`
  is the decoded vertex and index buffers plus every texture as RGBA8 with mipmaps (or its
  transcoded block-compressed size for KTX2); `ramBytes` is the file plus the decoded buffers.

## Textures: KTX2 or WebP

- Default: textures become WebP (`EXT_texture_webp`), which loads with no setup.
- `--ktx2`: textures become KTX2 (UASTC with Zstandard and mipmaps, `KHR_texture_basisu`). It needs
  the `ktx` CLI of [KTX-Software](https://github.com/KhronosGroup/KTX-Software) (4.4 or newer) on
  the `PATH`. **Experimental: this path has never been run**, and `@ceiba/babylon` does not load
  KTX2 chunks yet.

## Limits

- Triangles are never cut at chunk borders. A mesh larger than a chunk, such as terrain, sticks out
  of its chunk and loads and unloads all at once: split it per chunk in Blender.
- Static meshes only. Animations, skins, cameras, lights and GPU instancing
  (`EXT_mesh_gpu_instancing`) are dropped.
- Draco-compressed input is not supported; export without compression.
- The whole source is held in memory, and a mesh shared by nodes in several chunks is stored in
  each of them.
