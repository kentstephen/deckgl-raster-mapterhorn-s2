# Kickoff plan — 8 PM session (2026-05-23)

A concrete, ordered task list to execute when tokens reset (~8 PM). **No research
or coding done yet** — this is the plan only. Target area for the MVP is **Mount
Washington / the Presidentials, NH**, using the predecessor's default bounding
box for that area, tuned here first before generalizing.

Constraints locked: **S2 temporal-mosaic COGs in CONUS**, **USGS 3DEP 10 m DEM
via Mapterhorn** (`usgs3dep13`, the z13+ high-res source over CONUS), browser-only
deck.gl + maplibre, no backend.

---

## Phase 0 — Re-read context (5 min, no tools beyond Read)

1. Re-read `CLAUDE.md`, `docs/ROADMAP.md`, `.claude/memory/MEMORY.md`,
   `.claude/memory/TERRAIN_HANDOFF.md`, `.claude/memory/TERRAIN_RESEARCH.md`.
2. Confirm the MVP scope hasn't changed since this file was written.

## Phase 1 — Upstream check: deck.gl-raster ✅ DONE (2026-05-23 PM)

Verified against the predecessor's installed `0.7.0` tree:

- **Pinned versions:** deck.gl-raster / deck.gl-geotiff / geotiff / proj = `0.7.0`;
  `@deck.gl/core` 9.3.2; luma 9.3.3; maplibre-gl 5.24.0; react-map-gl 8.1.1.
  Plan: **pin to these** (don't bump for the spike).
- **Mesh path confirmed.** `RasterLayer._generateMesh()` → local
  `reprojectorToMesh()`. **Injection point: `raster-layer.js:181`,
  `positions[i*3+2] = 0`.** x,y (lines 178–179) are `exactOutputPositions` in
  **3857** → convert to lon/lat for the DEM lookup.
- `RasterReprojector` now lives in `@developmentseed/raster-reproject` 0.7.0
  (2D positions only; z added by `reprojectorToMesh`). `RasterMeshLayer` is NOT
  exported (that's Kyle Barron's lib) — our path is `RasterLayer`/`MeshTextureLayer`.
- **`_generateMesh` is synchronous** ⇒ DEM tiles must be pre-cached before mesh
  build; `elevationAt` is a sync cache lookup. Prefetch in `updateState` (or
  rebuild the mesh once tiles land). Do NOT fetch DEM inside the mesh builder.
- TODO at build time: still skim Dev Seed `deck.gl-raster` examples for any
  ready-made mesh-z/terrain pattern before hand-rolling the injection.

## Phase 2 — DEM source ✅ RESEARCHED — Mapterhorn (USGS 3DEP 10m at z13+)

**Mapterhorn carries the USGS 3DEP 10m for CONUS** (`usgs3dep13`), confirmed by
its own data-source popup. (My earlier "pivot to AWS terrain tiles" was wrong and
is dropped — AWS `elevation-tiles-prod` is effectively 30m.)

- URL: `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp` — terrarium **WebP**, 512px,
  maxzoom 17. Decode `(R*256 + G + B/256) - 32768`.
- **10m 3DEP only at z13+**; below that it's `glo30` 30m. ⇒ terrain loading
  targets **z≥13** over CONUS (this also sets the min-zoom / auto-load behavior).
- High-res is in regional `*.pmtiles`, but the xyz `.webp` endpoint serves them —
  **likely no PMTiles reader needed**, just fetch xyz WebP. (If the xyz endpoint
  misses high-res, fall back to reading the regional `*.pmtiles` via `pmtiles` lib.)
- WebP decode: fetch → `createImageBitmap` → canvas → `getImageData` → pixels.

Remaining Phase-2 tasks for 8 PM:

7. **Verify `tiles.mapterhorn.com` CORS** from a localhost dev origin (hard gate).
   source.coop itself is known CORS-open; confirm the tiles host specifically.
8. Confirm z13+ tiles return real 10m relief over Mount Washington (sanity-check a
   known summit elevation ≈ 1917 m / 6288 ft). Record max usable zoom (≤17).
9. Confirm the xyz endpoint actually serves `usgs3dep13` (not just glo30) at the
   Presidentials z13–16; if not, switch to the regional PMTiles archive.

## Phase 3 — Bounding box + sources for the MVP area

11. **Set the Mount Washington bbox.** Note: the predecessor's default bbox is
    `[-115.5, 31.5, -113.0, 33.5]` (Yuma AZ, ~2.5°×2°) — NOT NH. Mount Washington
    ≈ 44.27 N, −71.30 W. Use a Presidentials bbox of similar span, e.g.
    `[-71.55, 44.10, -71.05, 44.45]` (tighten for "closer-in"); set initial
    view center ≈ `[-71.30, 44.27]`, zoom ~12. Reuse the predecessor's
    `STAC_BBOX`/`initialViewState` mechanism, just with these coords.
12. Confirm the **S2 mosaic COGs for that bbox** are reachable (STAC fetch +
    `data.source.coop` CORS-open host, 2022–2024 visible years).
13. Note the **COG-extent vs DEM-tile-grid** relationship for this area (COGs
    likely larger than DEM tiles) — sketch how loading wires together.

## Phase 4 — Stand up the minimal scene

14. Copy the predecessor's `web/` scaffold into this repo; install with the
    pinned versions from Phase 1.
15. Get **one S2 COG tile rendering** over the Mount Washington bbox via
    `MosaicLayer`/`COGLayer` on interleaved `MapboxOverlay` + maplibre. No
    terrain yet — confirm baseline imagery works here.

## Phase 5 — The go/no-go spike (Path B)

16. **Constant-z monkey-patch:** patch `reprojectorToMesh` to set vertex
    `z = 3000 m`, pitch the maplibre map, confirm the imagery lifts and
    depth-sorts vs the basemap.
    - **Green** → Path B is viable; proceed to Phase 6.
    - **Red** (z ignored/flattened in interleaved mode) → STOP and pivot:
      scope Path A (`TerrainExtension` + likely standalone Deck) per ROADMAP.
17. Note **scale handling** observed during the spike (deck.gl needed an explicit
    scale before; capture how it behaves with the mesh here).

## Phase 6 — Build Path B (only if spike is green)

18. Implement `elevationAt(lon, lat) → meters`: in-memory terrarium-tile cache
    (mirror `geotiffCache`), fetch xyz WebP from `tiles.mapterhorn.com` at z≥13,
    decode to pixels (`createImageBitmap` → canvas → `getImageData`), terrarium
    decode, bilinear sample.
19. Inject z into the mesh: vendor/subclass `RasterLayer` so each vertex gets
    `z = elevationAt(x,y) * exaggeration` at `raster-layer.js:181` (3857 x,y →
    lon/lat). **Prefetch the DEM tiles covering the COG tile in `updateState`
    BEFORE `_generateMesh` runs** (it's synchronous) — or rebuild the mesh once
    tiles land.
20. Add the **exaggeration slider** (default ~1.5–2×).
21. Add the **DEM resolution control**: default highest available here (10 m),
    always allow **flat** (no terrain).
22. Handle **tile-edge seams**: snap DEM sampling to a consistent grid / sample
    at true tile-corner coords so adjacent COG tiles share identical edge z.
23. CONUS loading behavior: raise **min zoom**, **auto-load on move/pan** (don't
    load all of CONUS at once).

## Phase 7 — Wrap

24. Update `.claude/memory/MEMORY.md` with: chosen versions, CORS verdicts,
    spike go/no-go result, and any new unknowns.
25. Commit in logical chunks. No hillshade/relief styling this pass (TODO later).

---

## Hard gates / risks to resolve early

- **`tiles.mapterhorn.com` CORS** (task 7) — blocks the DEM path if closed;
  fallback = regional `*.pmtiles` via `pmtiles` lib, or a dev proxy.
- **z13+ for 10m** (task 9) — confirm the xyz endpoint serves `usgs3dep13`, not
  just glo30, at the Presidentials.
- **Spike result** (task 16) — go/no-go for Path B vs the heavier Path A pivot.
  This is the dominant unknown; everything else is wiring.
- **Sync mesh build vs async DEM** (task 19) — prefetch-then-build ordering.
- **Scale interaction** (task 17) — unknown, watch during spike.

(Resolved already: deck.gl-raster mesh path + injection point + pinned versions
— see Phase 1. DEM source — see Phase 2: Mapterhorn, USGS 3DEP 10m at z13+.)
