# Plan — "Ground Level" terrain datum shift

## Why

In high-elevation areas (e.g. Sangre de Cristo, base ~3000 m) the terrain mesh
floats thousands of meters above the z=0 plane. Under pitch that throws off
camera/zoom framing — the same trick Stephen used in his deck.gl H3 work was to
subtract the lowest elevation in view so the base sits near zero, recomputed as
the viewport moves, keeping zoom manageable.

## Mechanism in this stack

Terrain z = `realMeters × exaggeration`, set by the `TerrainLayer`
`elevationDecoder` (`offset: -32768 × k`). Subtracting a base **B** (real meters):
`offset: (-32768 − B) × k` ⇒ decoded z = `(realMeters − B) × k`. The base sits
near 0; the `TerrainExtension` drape reads the shifted heightmap, so imagery
follows for free.

**Constraint:** changing `elevationDecoder` reloads all terrain tiles. So B can't
update every frame. ⇒ **quantize B to 250 m and only update when the band
changes** — panning within a band = no reload; crossing into much higher/lower
terrain = one reload (like a year change).

## Pieces

1. `web/src/sampleElevation.ts` (new) — `sampleMinElevation(points): Promise<number>`:
   for each [lng,lat], compute its z13 Mapterhorn tile, fetch+decode (terrarium),
   bilinear-sample, return the min. Module-level tile cache (bounded).
2. `App.tsx`:
   - state `groundLevel: boolean` (toggle), `terrainBaseM: number` (default 0).
   - effect: on move/load, if `groundLevel`, sample center + 4 mid-edge points of
     the view, quantize min to nearest 250 m, `setTerrainBaseM` if changed.
     Toggling off resets to 0.
   - fold `terrainBaseM` into the decoder offset; add to `terrainLayer` deps.
   - UI: GROUND LEVEL toggle in the shared terrain controls + `−NNNN m` readout.

## Verification

- High area (Sangre de Cristo): toggle on → camera/zoom feels like a near-sea-
  level area; terrain + drape unchanged in shape, just lowered. Readout shows the
  subtracted base.
- Pan within ~250 m band → no terrain reload (watch console / network).
- Toggle off → base returns to true elevation.
