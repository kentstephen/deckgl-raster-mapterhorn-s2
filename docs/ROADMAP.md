# Roadmap — Sentinel-2 COG imagery on 3D Mapterhorn terrain

In-repo, committed version of the carried-over terrain plan. Deeper, scratch-
level context lives in `.claude/memory/TERRAIN_HANDOFF.md` and
`TERRAIN_RESEARCH.md` (gitignored).

**Feasibility verdict: YES.** A multi-day spike, not a rewrite — because the
imagery is already a textured 3D mesh drawn flat. Risk is concentrated in 2–3
known unknowns (listed under "Spike first").

## Goal

Render the Sentinel-2 COG imagery draped/elevated on a 3D terrain surface (DEM
from Mapterhorn: Copernicus GLO-30 global to z12 + hi-res EU, PMTiles / terrarium
encoding), with a vertical-exaggeration control. Keep the existing deck.gl +
maplibre interleaved stack.

## The decisive finding

`@developmentseed/deck.gl-raster`'s `RasterLayer` builds an adaptive reprojection
mesh (`reprojectorToMesh`) and renders it via `MeshTextureLayer`
(`extends SimpleMeshLayer`). Each vertex's z is hardcoded to `0`:

```js
positions[i*3 + 0] = exactOutputPositions[i*2];     // x
positions[i*3 + 1] = exactOutputPositions[i*2 + 1]; // y
positions[i*3 + 2] = 0;                              // z — "flat on the ground"
```

Give those vertices a real z and the imagery becomes a terrain surface. (Files:
`node_modules/@developmentseed/deck.gl-raster/dist/raster-layer.js`,
`.../dist/mesh-layer/mesh-layer.js`.)

## Path B — bake DEM elevation into the mesh (recommended)

1. **DEM source + cache.** Pull Mapterhorn terrarium tiles (PMTiles). Implement
   `elevationAt(lon, lat) → meters`, backed by an in-memory tile cache; decode
   terrarium `(R*256 + G + B/256) - 32768`; bilinear-sample within a tile. Mirror
   the predecessor's `geotiffCache` pattern.
2. **Inject z into the mesh.** Fork or subclass `RasterLayer` so that after the
   reprojection mesh is built, each vertex's `z = elevationAt(x,y) * exaggeration`
   (x,y in 3857 → lon/lat for the DEM lookup). No public hook — either (a) vendor
   a patched `RasterLayer`, or (b) subclass it and override the mesh-construction
   step. Async DEM fetch must resolve before the mesh model is created (hook the
   existing async mesh build in `updateState`).
3. **Exaggeration knob** in the panel (`z *= k`), default ~1.5–2× (real relief
   reads flat at these extents).
4. **Pitch the map.** Under interleaved `MapboxOverlay`, deck shares maplibre's
   camera; with `pitch > 0`, mesh z renders as real relief. No `setTerrain`
   needed for the deck layers.
5. **Tile-edge seams.** Adjacent COG tiles must sample identical z at shared
   edges or you get cracks — snap DEM sampling to a consistent grid, or sample at
   true tile-corner coords.

## Spike FIRST (de-risk before building)

- **Does an interleaved `MapboxOverlay` mesh with z≠0 actually elevate under
  maplibre pitch?** Monkey-patch `reprojectorToMesh` to a constant z (~3000 m),
  pitch the map, confirm the imagery lifts and depth-sorts vs the basemap. Green
  → Path B. Red → fall back to Path A or standalone Deck.
- DEM fetch/decode latency vs the existing tile pipeline (don't block paint).
- Whether maplibre's own `setTerrain` is needed for the *basemap* to match
  (it drapes maplibre layers, not deck layers — see Path C).

## Fallbacks

- **Path A — `TerrainExtension`.** Define a deck terrain source layer
  (`operation: 'terrain'`) + add `new TerrainExtension()` to the imagery layer's
  `extensions` (`terrainDrawMode` 'drape' vs 'offset'). Blockers:
  `RasterTileLayer`/`RasterLayer` don't forward an `extensions` prop to the mesh
  sublayer today (needs an upstream PR or fork), and it wants a deck-managed
  terrain in the same instance → likely means dropping maplibre-interleaved for a
  standalone Deck. Heavier.
- **Path C — maplibre `setTerrain` + Mapterhorn `raster-dem`.** Trivial, but only
  the basemap gets relief; deck imagery stays flat. Not sufficient alone.
- **OpenGlobus — avoid.** Separate WebGL globe engine, no deck.gl-geotiff bridge
  → full re-implementation of the COG read + GPU pipeline.

## Suggested first session

1. Read this + `CLAUDE.md` + the `.claude/memory/` handoff/research docs.
2. Stand up a minimal deck.gl-raster + maplibre scene rendering ONE COG tile
   (copy the predecessor's `web/` scaffold from the reference folder).
3. Run the Path-B constant-z spike under pitch. Decide.
4. If green: build `elevationAt()` + DEM cache, wire z into the mesh, add the
   exaggeration slider. If red: pivot to Path A and scope the standalone-Deck +
   `extensions`-forwarding work.

## Sources

- deck.gl TerrainExtension — https://deck.gl/docs/api-reference/extensions/terrain-extension
- deck.gl TerrainLayer — https://deck.gl/docs/api-reference/geo-layers/terrain-layer
- Mapterhorn (Protomaps) — https://protomaps.com/blog/mapterhorn-terrain/
- Mapterhorn 3D walkthrough — https://dev.to/mierune/building-a-3d-map-application-using-mapterhorn-terrain-data-elo
- deck.gl-raster repo — https://github.com/developmentseed/deck.gl-raster
