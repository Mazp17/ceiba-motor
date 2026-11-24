# worldgen

Generates a synthetic test world for `@ceiba/streaming`: a `manifest.json` and one `.glb` per
chunk. Private tool, not published. It exists so the streaming scene has several kilometres to
load before real art exists.

## Usage

```sh
pnpm world   # default world into apps/sandbox/public/world/ (gitignored)
node tools/worldgen/src/cli.ts --out <dir> [--size 64] [--chunk-size 256] [--seed 1]
```

| Option | Default | |
| --- | --- | --- |
| `--out` | required | Output directory. Its `chunks/` folder and `manifest.json` are replaced |
| `--size` | `64` | Side of the world, in chunks. The world is centred on chunk (0, 0) |
| `--chunk-size` | `256` | Side of a chunk, in metres. At least 64 |
| `--seed` | `1` | Integer. Same options and seed give byte-identical files |

Node 24 runs the TypeScript directly; there is no build step. The default world is 16.4 km
across: about 7,920 files (full and low detail), 96 MB, generated in about two seconds.

## Output

- `manifest.json`: a `WorldManifest`, checked with `validateManifest` before it is written.
  Each `url` is relative to the manifest (`chunks/3_-2.glb`), `hash` is the first 16 hex digits
  of the file's SHA-256, `gpuBytes` is the byte size of the vertex and index buffers, and
  `ramBytes` is the file size plus `gpuBytes` (an upper bound: the fetched file and a CPU copy
  of every buffer).
- About 3% of the chunks are left out on purpose (holes): not in the manifest, no file.
  Chunk (0, 0) always exists.
- Each chunk is one mesh with vertex colours and no textures: a ground tile (checker with a
  per-chunk tint), the orientation marker, and 0 to about 70 boxes. Density is shared by blocks
  of 4 x 4 chunks, so the world has empty and dense districts and chunk memory varies.

## Chunk frame contract

Loaded by Babylon's glTF loader into a default (left-handed) scene with no extra transform, a
chunk spans x in [0, chunkSize] and z in [0, chunkSize], y up, minimum corner at the origin.

The loader parents everything to a `__root__` node with a 180° turn about y and a scale of
(1, 1, -1), which together mirror x. The files are therefore written with x in [-chunkSize, 0]
and counter-clockwise triangles, as valid right-handed glTF; the mirror puts x back. The loader
adds that `__root__` node per file: position the root, do not strip its transform.

Every chunk has a magenta post, 1 m wide and 40 m tall, at chunk-local (10, _, 10), with an arm
at the top pointing along +x. If the post is not near the minimum corner, or the arm points
elsewhere, something flipped or rotated the chunk.

## What it is not

Not the asset pipeline: no compression or KTX2, and the `lod` of a chunk is just its ground and
buildings of 25 m or more, not a simplified mesh. Not a level generator either;
the content only has to be cheap, deterministic and easy to tell apart.
