# Kickoff plan — 8 PM session (2026-05-23)

A concrete, ordered task list to execute when tokens reset (~8 PM). **No research
or coding done yet** — this is the plan only. Target area for the MVP is **Mount
Washington / the Presidentials, NH**, using the predecessor's default bounding
box for that area, tuned here first before generalizing.

Constraints locked: **S2 temporal-mosaic COGs in CONUS**, **10 m Mapterhorn DEM**
(USGS-backed availability over Mount Washington), browser-only deck.gl + maplibre,
no backend.

---

## Phase 0 — Re-read context (5 min, no tools beyond Read)

1. Re-read `CLAUDE.md`, `docs/ROADMAP.md`, `.claude/memory/MEMORY.md`,
   `.claude/memory/TERRAIN_HANDOFF.md`, `.claude/memory/TERRAIN_RESEARCH.md`.
2. Confirm the MVP scope hasn't changed since this file was written.

## Phase 1 — Upstream check: deck.gl-raster (per standing order)

Goal: confirm the mesh path described in the handoff still matches what's on the
current `0.7` line before we build against it.

3. Inspect the **predecessor's pinned versions** in
   `reference-sentinel-2-cog-deckgl-raster/web/package.json` — record exact
   `@developmentseed/deck.gl-raster`, `deck.gl-geotiff`, `geotiff`, deck.gl,
   luma.gl, maplibre, react-map-gl versions.
4. Check **upstream Dev Seed `deck.gl-raster`** for newer releases since those
   pins: release notes / changelog for shader-pipeline shape changes, and
   confirm `RasterLayer` → `MeshTextureLayer` (`extends SimpleMeshLayer`) is
   still the render path and still hardcodes vertex `z = 0` in
   `reprojectorToMesh`. Decide: pin to predecessor versions (safe) or bump.
5. Review Dev Seed's **deck.gl-raster examples** for any pattern that already
   does mesh-z / terrain / elevation — don't reinvent if they demonstrate it.
6. Confirm the package still does **not** export `RasterMeshLayer` (Kyle Barron's
   separate lib); our mesh path is `RasterLayer`/`MeshTextureLayer`.

## Phase 2 — Upstream check + research: Mapterhorn DEM API

Follow the TERRAIN_HANDOFF instructions; fill the known unknowns.

7. Read **Mapterhorn's own docs/examples** for the terrarium PMTiles API:
   tile URL scheme, PMTiles access pattern from the browser, terrarium encoding
   confirmation `(R*256 + G + B/256) - 32768`, and zoom/coverage levels.
8. Confirm **10 m USGS-backed coverage over Mount Washington / Presidentials**
   exists at the zoom levels we'll use; record the max usable zoom there.
9. **Verify Mapterhorn DEM CORS** — confirm browser fetch of the PMTiles/tiles
   is allowed from a localhost dev origin. This is a hard gate; if blocked,
   note the fallback (proxy / alternate host) before building.
10. Pick the PMTiles reader approach (e.g. `pmtiles` lib) and confirm it plays
    with the existing HTTP Range idiom from `loadGeotiff.ts`/`getTileData.ts`.

## Phase 3 — Bounding box + sources for the MVP area

11. Pull the **default Mount Washington bounding box** from the predecessor
    (`stac.ts` / `App.tsx` initial view / any hardcoded extent) and record exact
    coords + initial zoom/center to reuse here.
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

18. Implement `elevationAt(lon, lat) → meters`: in-memory Mapterhorn tile cache
    (mirror `geotiffCache`), terrarium decode, bilinear sample within a tile.
19. Inject z into the mesh: vendor/subclass `RasterLayer` so each vertex gets
    `z = elevationAt(x,y) * exaggeration` after the reprojection mesh is built
    (3857 x,y → lon/lat). Hook the async DEM fetch before the mesh model is
    created in `updateState`.
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

- **Mapterhorn CORS** (task 9) — blocks the whole DEM path if closed.
- **Spike result** (task 16) — go/no-go for Path B vs the heavier Path A pivot.
- **Version drift** on the `0.7` line (tasks 3–4) — pin before building.
- **Scale interaction** (task 17) — unknown, watch during spike.
