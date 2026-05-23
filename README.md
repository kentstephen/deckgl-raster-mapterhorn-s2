# deckgl-raster-mapterhorn-s2

**3D terrain continuation** of
[`sentinel-2-cog-deckgl-raster`](https://github.com/kentstephen/sentinel-2-cog-deckgl-raster):
take the browser-side Sentinel-2 COG renderer and drape/elevate the imagery over
a **3D terrain surface** built from **Mapterhorn** DEM tiles, with a
vertical-exaggeration control. Still no tile server and no backend — the browser
reads per-tile COGs over HTTP Range and samples terrarium DEM tiles client-side.

> **Status: scaffolding only.** No code or research has been done in this repo
> yet. This README, `CLAUDE.md`, and `docs/ROADMAP.md` capture the plan carried
> over from the predecessor project. The build starts from the spike described
> below.

## The idea in one paragraph

The predecessor renders Sentinel-2 imagery with `@developmentseed/deck.gl-raster`,
whose `RasterLayer` already builds an **adaptive reprojection mesh** (textured 3D
geometry) and renders it via `MeshTextureLayer` — but it hardcodes every vertex's
`z` to `0`, so the imagery lies flat. This project gives those vertices a **real
elevation** sampled from a [Mapterhorn](https://protomaps.com/blog/mapterhorn-terrain/)
DEM (Copernicus GLO-30 global + hi-res EU, distributed as PMTiles / terrarium
encoding). Under maplibre `pitch`, the textured mesh then renders as real relief.
No engine swap — that's the bet.

## Plan (Path B)

1. **DEM module** — `elevationAt(lon, lat) → meters`, backed by an in-memory
   terrarium-tile cache; decode `(R*256 + G + B/256) - 32768`, bilinear-sample.
2. **Inject z into the mesh** — fork/subclass `RasterLayer` to set each vertex
   `z = elevationAt(x,y) * exaggeration` after the reprojection mesh is built.
3. **Exaggeration slider** in the panel (default ~1.5–2×).
4. **Pitch the map** — interleaved `MapboxOverlay` shares maplibre's camera; the
   mesh z renders as relief.
5. **Seam handling** — snap DEM sampling to a consistent grid so adjacent COG
   tiles share edge elevations.

**De-risk first** with a constant-z monkey-patch spike under pitch. Fallbacks
(`TerrainExtension` / standalone Deck, maplibre `setTerrain`) and the full
rationale are in [`docs/ROADMAP.md`](./docs/ROADMAP.md).

## Stack (inherited)

- [`@developmentseed/deck.gl-geotiff`](https://github.com/developmentseed/deck.gl-raster/tree/main/packages/deck.gl-geotiff)
  — `MosaicLayer` / `COGLayer` / `MultiCOGLayer`.
- [`@developmentseed/deck.gl-raster`](https://github.com/developmentseed/deck.gl-raster)
  — shader pipeline building blocks + the mesh path being patched.
- [`@developmentseed/geotiff`](https://github.com/developmentseed/deck.gl-raster/tree/main/packages/geotiff)
  — COG reader.
- deck.gl 9.3 + luma.gl 9.3 + maplibre-gl 5 + react-map-gl 8 + React 19,
  rendered interleaved via `@deck.gl/mapbox` `MapboxOverlay`.
- DEM: [Mapterhorn](https://protomaps.com/blog/mapterhorn-terrain/) terrarium
  PMTiles.

> The deck.gl-raster `0.7` line moves fast and the shader-pipeline shape changes
> across minor versions — **check the latest from the Dev Seed repos before you
> start**, and pin versions.

## Relationship to the predecessor

A local, gitignored copy of the predecessor repo lives at
`reference-sentinel-2-cog-deckgl-raster/` for reference (COG read patterns, STAC
fetch, the panel, the colormap pipeline). The predecessor's full README, footgun
list, and `.claude/memory/` notes explain the imagery side; this repo focuses on
adding terrain.

## Run

Nothing to run yet — no `web/` app has been scaffolded. Once it exists the
intended flow mirrors the predecessor:

```bash
cd web
npm install
npm run dev
```

## Docs

- [`CLAUDE.md`](./CLAUDE.md) — project instructions + the core idea.
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — Path B plan, the spike, and fallbacks.
- `.claude/memory/` (gitignored) — running notes, plus the carried-over
  `TERRAIN_HANDOFF.md` / `TERRAIN_RESEARCH.md` deep dives.
