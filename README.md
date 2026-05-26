# deckgl-raster-mapterhorn-s2

Drape **Sentinel-2** satellite imagery over **3D terrain**, entirely in the
browser — no tile server, no backend. The browser reads cloud-optimized GeoTIFFs
(COGs) over HTTP range requests, fetches terrain DEM tiles, and renders the
imagery as a texture on the elevation surface with deck.gl + MapLibre.

It's a 3D continuation of
[`sentinel-2-cog-deckgl-raster`](https://github.com/kentstephen/sentinel-2-cog-deckgl-raster)
(which rendered the same imagery flat).

---

## How it works (the 30-second version)

Two layers stacked by deck.gl, rendered interleaved into MapLibre's WebGL canvas:

1. **A terrain surface** — deck's `TerrainLayer` fetches
   [Mapterhorn](https://mapterhorn.com) DEM tiles (elevation encoded as RGB),
   decodes them to heights, and builds a 3D mesh. A **custom `fetch`** reads the
   tiles itself, **entirely from Mapterhorn's PMTiles archives on Source
   Cooperative** via HTTP range reads: the global 30 m base (≤z12) from
   `planet.pmtiles`, and **hi-res detail (≥z13, ≤10 m) from the regional
   archives** where they exist — worldwide. See "Terrain fetch" below.
2. **The imagery** — deck.gl-raster reads Sentinel-2 COGs and renders them.
   Adding deck's **`TerrainExtension`** in `'drape'` mode makes that imagery a
   **texture painted onto the terrain mesh**, so it follows every ridge and
   valley instead of lying flat.

Tilt the camera (`pitch`) and you see real relief. An exaggeration slider scales
the heights; "GO FLAT" drops back to 2D.

```
Sentinel-2 COG ──► deck.gl-raster ──┐
 (source.coop)                       ├─► TerrainExtension('drape')
                                     │        │ paints imagery onto…
Mapterhorn DEM ──► TerrainLayer ─────┘        ▼
 PMTiles (source.coop):                 the terrain mesh ──► MapLibre canvas
 ≤z12 planet 30 m · ≥z13 regional ≤10 m
```

> **Why "drape" matters:** deck.gl-raster renders imagery as an *instanced* mesh,
> so `TerrainExtension` defaults to `'offset'` mode — which rigidly shifts each
> flat image tile up by a single elevation value (flat plates, glitchy). Forcing
> `terrainDrawMode: 'drape'` paints the imagery as a texture onto the *fine*
> terrain mesh instead. That one prop was the difference between "broken" and a
> clean drape. See `web/src/App.tsx`.

---

## Data sources

| What | Where | Notes |
|------|-------|-------|
| **Imagery** | Earth Genome Sentinel-2 Temporal Mosaics on [Source Cooperative](https://source.coop/earthgenome/sentinel2-temporal-mosaics) | Native **10 m**. Annual composites; a precomposed 8-bit "TCI" true-color COG per tile. CORS-open years: 2022–2024. |
| **Elevation (detail ≥z13)** | Mapterhorn regional PMTiles on [Source Cooperative](https://source.coop/mapterhorn/mapterhorn) (`…/mapterhorn/mapterhorn/{6-x-y}.pmtiles`) | Terrarium WebP, **≤10 m** (USGS 3DEP over CONUS; other hi-res sources elsewhere). **457 archives span all continents** — hi-res wherever Mapterhorn has it. Read via HTTP range (CORS-open). One archive per ~622 km z6 region. |
| **Elevation (base ≤z12)** | Mapterhorn `planet.pmtiles` on [Source Cooperative](https://source.coop/mapterhorn/mapterhorn) | Terrarium WebP, **30 m Copernicus glo30**, global. 705 GB archive but range-read (header + 6.6 KB root dir to open; leaf dirs + tiles on demand) — so the whole DEM shares one S3 range-read path. |
| **Catalog** | Earth Search STAC API (imagery) · Mapterhorn `download_urls.json` (DEM archive index: bbox + zoom per region) | Queried to find which COGs / which PMTiles archive cover the view. |
| **Basemap** | CARTO Voyager | Labels/context under the deck layers. |

Terrarium decode: `height = R*256 + G + B/256 - 32768` meters.

### Terrain fetch (why PMTiles)

All terrain is range-read from Source Cooperative **PMTiles** — no xyz tile
server. Mapterhorn publishes the DEM as static archives: one global
`planet.pmtiles` (z0–12, 30 m) plus one regional bundle per z6 region (z13+,
≤10 m). Their tiles are Hilbert-contiguous, so range reads **coalesce** and the
browser caches each archive's directory — fewer round-trips than per-tile xyz
GETs, and the same path at every zoom. `terrain/mapterhornPmtiles.ts` opens the
covering archive (regional from the `download_urls.json` index; `planet` for the
base), caches the `PMTiles` instance, and reads tiles by `(z,x,y)` via
`readTerrainTile`; the `TerrainLayer` `fetch` routes ≤z12 → planet, ≥z13 →
regional. `coverageAt(lon,lat)` reports which source covers the view so the panel
label reads "hi-res ≤10 m" or "GLO-30 30 m" by location.

---

## Run it

```bash
cd web
npm install
npm run dev      # → the URL Vite prints
```

Other scripts: `npm run build`, `npm run preview`, `npm run typecheck`.

The app opens on the **Sangre de Cristo / Culebra Range** (southern Colorado).
Pan/zoom and imagery auto-loads for the view. Append `?spike=terrain` to the URL
to load the throwaway proof-of-concept instead of the full app.

---

## The panel

- **Area** — search a place, draw an AOI box, "FETCH VIEW" to load the current
  view, toggle labels, reset north / default view, pause auto-load on move.
- **Render** — RGB true-color; a **false-color band composite** (Color-IR
  B08/B04/B03, NIR·G·B) with gain + black-point; or a spectral index
  (NDVI/NDWI/GNDVI/REDNESS) with a colormap (matplotlib/cmocean + CARTO ramps
  incl. `bluyl`) + range controls. *(False color stacks raw bands, so it shows
  the Earth Genome mosaic's per-scene seams; the indices cancel them via the
  normalized-difference ratio.)*
- **Terrain** — GO FLAT / GO 3D, an exaggeration slider (1× = true scale), and a
  ground-level datum that drops high terrain toward z=0 so tall ranges read as
  relief instead of floating.
- **Console** — captured errors/warnings, copyable, so you don't need DevTools.

---

## Code map

Everything is in `web/src/`.

| File | Role |
|------|------|
| `App.tsx` | The whole app: state, the `TerrainLayer` + `MosaicLayer` wiring, the panel UI. **Start here.** |
| `terrain/mapterhornPmtiles.ts` | Reads all DEM tiles from Mapterhorn's Source Cooperative PMTiles — `planet.pmtiles` base (≤z12) + regional archives (≥z13). Archive index (from `download_urls.json`), per-archive `PMTiles` cache, z6-ancestor selection, `readTerrainTile(z,x,y)`, and `coverageAt(lon,lat)` for the location-aware source label. |
| `raster/clampedTerrainLoader.ts` | Custom DEM tile decoder: terrarium → height grid → Martini mesh. Adds a **despeckle** (median filter, removes nodata "needle" spikes — tuned light for speed: 1 pass / 3×3) and **skirts** (hides tile-edge seams). |
| `stac.ts` | STAC search + CORS-host filtering to find COGs for an area/year. |
| `loadGeotiff.ts`, `getTileData.ts` | Open a COG and read/decode tiles (with a module-level cache). |
| `renderTile.ts`, `renderPipeline.ts` | deck.gl-raster shader pipelines — RGB gain, false-color band stacks (`FALSE_COLORS`, `buildFalseColorPipeline`), NDVI/index math, colormaps. |
| `shaders/`, `cartoColormaps.ts`, `discardBlack.ts` | GLSL shader modules (incl. `falseColor.ts` reflectance stretch) + colormap helpers. |
| `consoleCapture.ts` | Mirrors console errors/warnings into the in-panel log. |
| `geocode.ts`, `PlaceSearch.tsx`, `prefs.ts`, `loadStats.ts` | Search, persisted prefs, load scoreboard. |
| `raster/Elevated*.ts`, `elevation.ts` | **Dead code** from the abandoned Path B (hand-rolled mesh z-injection). Kept on the branch; safe to delete. |

### The stack

deck.gl 9.3 (`@deck.gl/core`, `/geo-layers` for `TerrainLayer`, `/extensions`
for `TerrainExtension`, `/mapbox` for the interleaved overlay) · luma.gl 9.3 ·
MapLibre GL 5 · react-map-gl 8 · React 19 · Vite. Imagery via Development Seed's
`@developmentseed/deck.gl-{raster,geotiff}` + `geotiff` (0.7). DEM meshing via
`@mapbox/martini`; DEM archives read with [`pmtiles`](https://github.com/protomaps/PMTiles).

---

## Known limitations

- **Bare terrain at the frame edges.** Under tilt the camera sees past the loaded
  imagery extent toward the horizon — a common artifact of extruded/3D maps in
  deck.gl, not a wiring bug. Two contributors, two fixes:
  - *Terrain tiles* that extrude into frame from off-screen are handled by
    `TileLayer`'s [`zRange`](https://deck.gl/docs/api-reference/geo-layers/tile-layer)
    prop (min/max elevation), which `TerrainLayer` already computes internally;
    recent deck.gl also loads far tiles at lower zoom automatically.
    *(Our terrain layer relies on this default — revisit `zRange` if horizon
    terrain ever drops out.)*
  - *Imagery* simply isn't fetched that far: `handleFetchViewport` caps the AOI
    at `MAX_VIEWPORT_SPAN_DEG` (= 5°) so a tilted view can't enumerate thousands
    of COGs. Raising that cap (or fetching from the full pitched `getBounds`)
    fills the edges, at the cost of opening more COGs.
- **Main-thread jank.** The DEM loader runs `worker: false`, so decode + despeckle
  + meshing happen on the main thread. Despeckle is tuned light (1 pass / 3×3) and
  `meshMaxError`/cache are capped, but heavy panning can still stutter. Moving the
  loader to a Web Worker is the real remaining perf win. (PMTiles + source.coop
  fixed *fetch* throughput, not decode cost.)
- **Worldwide, hi-res where available.** Terrain renders globally: ≤10 m wherever
  Mapterhorn has a hi-res regional archive (CONUS, much of Europe, etc.), 30 m
  glo30 everywhere else and below z13. The panel label reflects which you're on.
  **Imagery** is the narrower constraint — only Earth Genome items on the
  CORS-open `data.source.coop` host load, so imagery is patchier than terrain
  outside that coverage (the rest is on a CORS-blocked bucket).
- **False color shows mosaic seams.** Raw band stacks (CIR/NIR) don't cancel the
  Earth Genome mosaic's per-scene brightness offsets the way the ratio indices do,
  so acquisition seams are visible. No SWIR composites — only the CORS-open 10 m
  bands (B02/B03/B04/B08) are available.
- **Steep faces soften slightly.** Drape fidelity is bounded by the terrain mesh /
  cover-texture resolution, not the imagery.
- **Debug leftovers.** `clampedTerrainLoader.ts` still has a one-shot `parse() RAN`
  log and a `?demdebug` histogram mode. Harmless.

See `docs/` for the design history — `ROADMAP.md` (original plan + fallbacks),
`TERRAIN_DRAPE_PLAN.md` (the drape-mode fix), `TERRAIN_SPIKES_PLAN.md` (spike
debugging). Note `ROADMAP.md` predates the pivot to `TerrainLayer` +
`TerrainExtension`; this README reflects what's actually built.
