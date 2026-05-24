# deckgl-raster-mapterhorn-s2

A continuation of [`sentinel-2-cog-deckgl-raster`](https://github.com/kentstephen/sentinel-2-cog-deckgl-raster):
render Earth Genome's Sentinel-2 Temporal Mosaic COGs **draped/elevated on a 3D
terrain surface** built from **Mapterhorn** DEM tiles (Copernicus GLO-30 global +
hi-res EU, PMTiles / terrarium encoding), with a vertical-exaggeration control.
Keep the existing browser-only deck.gl + maplibre stack — no tile server, no
backend.

**Status:** scaffolding only. No research or coding has started in this repo yet.
The plan is carried over from the predecessor; see `docs/ROADMAP.md` (committed)
and `.claude/memory/TERRAIN_HANDOFF.md` + `TERRAIN_RESEARCH.md` (gitignored,
deeper context).

## The core idea (why this is feasible)

In `@developmentseed/deck.gl-raster`, `RasterLayer` does **not** draw a flat
bitmap — it builds an **adaptive reprojection mesh** and renders it with
`MeshTextureLayer` (`extends SimpleMeshLayer`). The mesh builder
(`reprojectorToMesh`) hardcodes each vertex's `z = 0` ("flat on the ground").

⇒ Terrain is mostly *"give those vertices a real z,"* not *"add a new draping
layer."* That's why this is a multi-day spike, not an engine rewrite.

Note: this package does **not** export `RasterMeshLayer` (that's Kyle Barron's
separate older `deck.gl-raster`). The mesh path here is
`RasterLayer` / `MeshTextureLayer`.

## Recommended path — Path B (bake DEM z into the mesh)

1. **DEM source + cache.** Pull Mapterhorn terrarium tiles (PMTiles). Build a
   small `elevationAt(lon, lat) → meters` module backed by an in-memory tile
   cache; decode terrarium `(R*256 + G + B/256) - 32768`; bilinear-sample.
   Mirror the predecessor's `geotiffCache` idiom.
2. **Inject z into the mesh.** Fork or subclass `RasterLayer` so each vertex
   gets `z = elevationAt(x,y) * exaggeration` after the reprojection mesh is
   built (x,y in 3857 → lon/lat for the DEM lookup). No public hook — vendor a
   patched layer or override the mesh-construction step.
3. **Exaggeration knob** in the panel (`z *= k`), default ~1.5–2×.
4. **Pitch the map.** Under interleaved `MapboxOverlay`, deck shares maplibre's
   camera; with `pitch > 0`, mesh z renders as real relief. No `setTerrain`
   needed for the deck layers.
5. **Tile-edge seams.** Adjacent COG tiles must sample identical z at shared
   edges or you get cracks — snap DEM sampling to a consistent grid.

**Spike first:** monkey-patch `reprojectorToMesh` to a constant z (~3000 m),
pitch the map, confirm the imagery lifts and depth-sorts vs the basemap. Green
→ build Path B. Red → fall back to Path A (`TerrainExtension`, likely standalone
Deck). Full fallbacks in `docs/ROADMAP.md`.

## Predecessor stack (carried forward)

- `@developmentseed/deck.gl-geotiff` 0.7 — `MosaicLayer` / `COGLayer` /
  `MultiCOGLayer`.
- `@developmentseed/deck.gl-raster` 0.7 — shader pipeline blocks.
- `@developmentseed/geotiff` 0.7 — COG reader.
- deck.gl 9.3 + luma.gl 9.3 + maplibre-gl 5 + react-map-gl 8 + React 19.
- Rendered **interleaved** via `@deck.gl/mapbox` `MapboxOverlay` on maplibre.

> The `0.7` line moves fast and the shader-pipeline shape changes across minor
> versions. **Check the latest from the Dev Seed repos before developing** and
> pin versions.

## Standing order — always check upstream

Before writing or changing anything touching the deck.gl-raster pipeline or the
DEM, **check upstream examples first** — Dev Seed's `deck.gl-raster` examples and
Mapterhorn's own docs/examples. The libraries move fast; don't reinvent a pattern
they already demonstrate. This is a recurring instruction, not a one-time step.

## Scope for the first pass (per Stephen, 2026-05-22)

- **No elevation styling yet.** No hillshade, no colored relief — just overlay
  the Sentinel-2 imagery we already access onto the Mapterhorn terrain surface.
  Styling the elevation is a **TODO** for later (it would make sense eventually).
- **User picks DEM resolution.** Mapterhorn offers several res levels — default
  to the **highest available**, but expose a new dashboard control to pick among
  what's available, and **always allow flat** (no terrain).
- **Resolution mismatch caveat.** A 1 m DEM under 10 m imagery may not make
  sense; keep that in mind when choosing/limiting selectable levels.
- **Geographic scope is open.** Tempting to start CONUS-only, but that misses a
  lot of good terrain worldwide. Not decided — leave both directions open.
  - **MVP starting area (Stephen, 2026-05-23): Mount Washington / the
    Presidentials, NH.** Begin with the **default bounding box we'd pull from
    the predecessor project** (sentinel-2-cog-deckgl-raster) for that area, and
    **tune everything here first** before generalizing.
  - **Update (Stephen, 2026-05-23): lock to CONUS to start.** Raise the **min
    zoom** so we don't load all of CONUS at once, and **auto-load on
    move/pan** instead. Realistic working extent is "a good chunk of California
    + the Rockies, not much more" — **closer-in views are what matter**. No
    override knob needed.
  - Stick with the **10 m** DEM: Sentinel-2 is native 10 m, so a 1 m DEM under it
    doesn't make sense; 10 m is the best fit for the imagery.
  - **DEM source correction (researched 2026-05-23):** the 10 m comes from
    **USGS 3DEP**, delivered as terrarium tiles by AWS/Mapzen
    (`elevation-tiles-prod`, PNG, maxzoom 15) — **not Mapterhorn**. Mapterhorn is
    Copernicus **30 m** over the US (hi-res only in Europe/Switzerland), so it
    can't serve the 10 m goal. Keep the DEM module source-agnostic (terrarium
    decode works for both); default to USGS 10 m, keep Mapterhorn selectable for
    later/EU. The repo name stays "mapterhorn" but the MVP DEM is USGS 3DEP.
  - Note: COGs are likely **larger than the DEM tiles** (unconfirmed) — mind the
    COG-extent vs DEM-tile-grid relationship when wiring loading.
  - **Later (not first pass):** Mapterhorn appears to ship several
    pre-processed viz varieties (hillshade, etc.). Let the user **drop the
    satellite imagery and view those terrain renders** directly. All in good
    time — the priority is to **drape the S2 over the Mapterhorn terrain**.
- **Scale handling is an unknown.** deck.gl needed an explicit scale setting in
  prior work; how scale interacts with Mapterhorn/deck.gl here is TBD — look into
  it during the spike.

## What to copy from the predecessor

The reference copy lives at `reference-sentinel-2-cog-deckgl-raster/` (local
only, gitignored). Useful files:

- `web/src/loadGeotiff.ts`, `getTileData.ts` — COG open + range-read + the
  module-level cache idiom to mirror for DEM tiles.
- `web/src/stac.ts` — STAC fetch + CORS-host filtering (imagery source).
- `web/src/App.tsx` — `MosaicLayer`/`COGLayer` wiring, the panel, the
  `smoothing` per-tile render-option pattern.
- `web/src/renderPipeline.ts`, `cartoColormaps.ts` — index pipeline + colormaps
  (if spectral modes are kept).

## Gotchas (carried forward)

- `MultiCOGLayer` compares `sources` by reference — cache source records per
  `(mode, id)` or it refetches every render.
- `updateTriggers.renderTile` is mandatory for prop changes to reach cached
  tiles.
- Imagery is native 10 m; nothing renders sharper.
- CORS: only `data.source.coop` is verified open for the imagery (2022–2024
  visible; earlier years are on a CORS-blocked bucket).
- Mapterhorn DEM CORS must also be verified before relying on browser fetch.

## Tone & conduct

Inherits global rules from `~/CLAUDE.md`. No flattery, no unsolicited critique,
no "you're absolutely right." Treat the user as a peer.

## Memory

Per global rule, running notes live in `.claude/memory/` (gitignored), not the
auto memory path. Start with `.claude/memory/MEMORY.md`.
