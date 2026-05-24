# Plan — finish the Mount Washington terrain demo

## Context

Goal: drape Earth Genome's Sentinel-2 mosaic COGs over real 3D terrain at Mount
Washington / the Presidentials, with a vertical-exaggeration control and a
DEM-resolution selector (incl. flat). Browser-only, keep the deck.gl + maplibre
interleaved stack. This is the Path-B approach from `TERRAIN_HANDOFF.md`: bake DEM
elevation into the deck.gl-raster reprojection mesh (no new draping layer).

This session already did the scaffolding and de-risking below; what remains is
the real z-injection, the DEM module, and the UI controls.

## What's already done / validated this session

- **Scaffold copied** from the predecessor into `web/`; deps installed; dev
  server runs (now on **port 5460**, `vite.config.ts`).
- **Bbox + view set to Mount Washington** in `web/src/App.tsx`
  (`STAC_BBOX = [-71.55, 44.1, -71.05, 44.45]`, initial center −71.3033/44.2706,
  zoom 13). Page title + vite base path + package name renamed.
- **Imagery confirmed:** STAC returns 8 CORS-open items over the bbox
  (MGRS 19TCK/19TCJ/18TYQ/18TYP) on `data.source.coop`.
- **DEM fully validated at the data level:** Mapterhorn xyz endpoint
  `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp` returns terrarium **WebP** 512px,
  **CORS open** (`access-control-allow-origin: *`). Decoded z13 tile max elevation
  = **1915.6 m** (Mt Washington summit is 1916 m) → real `usgs3dep13` 10 m data,
  terrarium formula `(R*256 + G + B/256) - 32768` correct. 10 m only at **z≥13**.
- **Injection point confirmed in installed code:**
  `node_modules/@developmentseed/deck.gl-raster/dist/raster-layer.js:181`,
  `positions[i*3+2] = 0` inside local `reprojectorToMesh()`.
- **Scale resolved:** `exactOutputPositions` are EPSG:3857 **meters**;
  `raster-tile-layer.js:199` modelMatrix scales x,y by
  `WEB_MERCATOR_TO_WORLD_SCALE` but **z by 1**. ⇒ inject
  `z = elevationMeters * WEB_MERCATOR_TO_WORLD_SCALE * exaggeration`.
- `_generateMesh` is **synchronous** → DEM tiles must be pre-cached before the
  mesh builds; `elevationAt` must be a sync lookup.
- **Spike is mid-flight:** `raster-layer.js` currently carries a throwaway ripple
  patch (z = 2000 + 1500·sin(y/300)) and `App.tsx` has `pitch: 60`. Both are
  spike-only and must be reverted (see step 0).

## Step 0 — Finish the go/no-go spike (last unverified assumption)

Take the ripple screenshot (`node web/spike-shot.mjs /tmp/spike2.png`). Expected:
visible 3D waves in the imagery under pitch → confirms interleaved `MapboxOverlay`
honors mesh z. (First constant-z shot already rendered pitched imagery, so this is
high-confidence.) If green, proceed. If red, pivot to Path A (`TerrainExtension`
+ standalone Deck) per `docs/ROADMAP.md`. Then **revert** the node_modules patch
and `App.tsx` pitch before building.

## Step 1 — DEM module: `web/src/elevation.ts`

Mirror the predecessor's module-level cache idiom (`loadGeotiff.ts`/`getTileData.ts`).

- `fetchTerrainTile(z,x,y)`: fetch the Mapterhorn WebP → `createImageBitmap` →
  draw to an `OffscreenCanvas` → `getImageData` → cache the `Float32Array` of
  decoded meters per tile (terrarium decode). Module-level `Map` cache keyed
  `${z}/${x}/${y}`, same as `geotiffCache`.
- `elevationAt(lon, lat, z)`: lon/lat → tile + pixel, **bilinear sample**;
  returns meters. Synchronous; returns `0` (or last-known) on cache miss.
- `prefetchTilesForBounds(bounds3857, z)`: returns a promise resolving when all
  terrain tiles covering a COG tile's extent are decoded into cache.
- Pin DEM zoom to `max(13, min(15, mapZoom))` so we always get ≥10 m 3DEP.

## Step 2 — Elevated raster layer (the z injection)

`RasterTileLayer` hardcodes `new RasterLayer` with no class hook, so vendor a thin
local copy or subclass both:

- `web/src/raster/ElevatedRasterLayer.ts` — subclass `RasterLayer`; override the
  mesh build so each vertex z =
  `elevationAt(lonlat) * WEB_MERCATOR_TO_WORLD_SCALE * exaggeration`. Convert each
  vertex's 3857 x,y → lon/lat for the lookup. Reuse the upstream
  `reprojectorToMesh` body, changing only line-181-equivalent.
- `web/src/raster/ElevatedRasterTileLayer.ts` — subclass `RasterTileLayer`,
  override `_renderSubLayers` to instantiate `ElevatedRasterLayer` instead of
  `RasterLayer` (copy the ~60-line method; only the `new` call changes).
- **Async ordering:** in `ElevatedRasterTileLayer`, before returning the sublayer,
  ensure terrain tiles for `props.tile`'s 3857 bounds are prefetched
  (`prefetchTilesForBounds`); trigger a re-render once they land so the
  synchronous `_generateMesh` sees a warm cache. Thread `exaggeration` via
  `updateTriggers` so changes rebuild the mesh.
- Wire `COGLayer`/`MosaicLayer` in `App.tsx` to use the elevated tile layer.
  (Check whether `MosaicLayer`/`COGLayer` expose a sublayer-class override; if
  not, also vendor the thin `COGLayer` wrapper that points at the elevated tile
  layer.)

## Step 3 — UI controls (panel in `App.tsx`)

- **Exaggeration slider** (0–3×, default ~1.5×); `updateTriggers.renderTile`-style
  trigger so the mesh rebuilds.
- **DEM resolution selector**: `Flat` (no terrain, z=0 — current behavior),
  `10 m (z13+)` default. "Flat" just bypasses the elevated layer / sets exag 0.
- Keep `pitch` user-controllable (maplibre drag); add a "tilt" reset alongside the
  existing north-reset button.

## Step 4 — Seams & polish

- **Tile-edge seams:** adjacent COG tiles must sample identical z at shared 3857
  edges. Sample `elevationAt` at true edge coords / snap to a consistent DEM grid
  so neighbors agree. Verify no cracks at MGRS tile boundaries (19T/18T meet near
  the summit).
- Confirm depth-sorting vs basemap is sane; tune default exaggeration for the
  Presidentials extent.

## Files

- Modify: `web/src/App.tsx` (layer wiring, panel controls, revert spike pitch).
- New: `web/src/elevation.ts`, `web/src/raster/ElevatedRasterLayer.ts`,
  `web/src/raster/ElevatedRasterTileLayer.ts` (+ thin COGLayer wrapper if needed).
- Revert: node_modules `raster-layer.js` spike patch (real injection lives in our
  subclass, not node_modules).
- Reference (read-only): upstream `raster-layer.js`, `raster-tile-layer.js`,
  `raster-tile-layer/constants.js`; predecessor `loadGeotiff.ts`/`getTileData.ts`.

## Verification

1. `node web/spike-shot.mjs` (Brave headless via `playwright-core`) — screenshots
   the pitched view; eyeball that relief tracks real topography (Mt Washington /
   Tuckerman ravine, Presidential ridgeline) and the summit reads ~1916 m tall at
   1× exaggeration.
2. Toggle exaggeration 0→3× → relief scales smoothly, no crash.
3. Toggle Flat → imagery lies flat; 10 m → relief returns.
4. Pan across the 18T/19T MGRS boundary → no seams/cracks between COG tiles.
5. Zoom out below z13 → no errors (terrain coarsens to glo30 or turns off per the
   chosen zoomed-out behavior).
