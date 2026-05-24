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
   decodes them to heights, and builds a 3D mesh.
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
 (terrarium tiles)                     the terrain mesh ──► MapLibre canvas
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
| **Elevation** | Mapterhorn `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp` | Terrarium-encoded WebP. **10 m USGS 3DEP at z13+** over CONUS; 30 m Copernicus glo30 below z13. |
| **Catalog** | Earth Search STAC API | Queried per area/year to find which COGs cover the view. |
| **Basemap** | CARTO Positron | Labels/context under the deck layers. |

Terrarium decode: `height = R*256 + G + B/256 - 32768` meters.

---

## Run it

```bash
cd web
npm install
npm run dev      # → the URL Vite prints
```

Other scripts: `npm run build`, `npm run preview`, `npm run typecheck`.

The app opens on the **Grand Canyon**. Pan/zoom and imagery auto-loads for the
view. Append `?spike=terrain` to the URL to load the throwaway proof-of-concept
instead of the full app.

---

## The panel

- **Area** — search a place, draw an AOI box, "FETCH VIEW" to load the current
  view, toggle labels, reset north.
- **Render** — RGB true-color, or a spectral index (NDVI/NDWI/…) with colormap +
  range controls.
- **Terrain** — GO FLAT / GO 3D, and an exaggeration slider (1× = true scale).
- **Console** — captured errors/warnings, copyable, so you don't need DevTools.

---

## Code map

Everything is in `web/src/`.

| File | Role |
|------|------|
| `App.tsx` | The whole app: state, the `TerrainLayer` + `MosaicLayer` wiring, the panel UI. **Start here.** |
| `raster/clampedTerrainLoader.ts` | Custom DEM tile decoder: terrarium → height grid → Martini mesh. Adds a **despeckle** (removes nodata "needle" spikes) and **skirts** (hides tile-edge seams). |
| `stac.ts` | STAC search + CORS-host filtering to find COGs for an area/year. |
| `loadGeotiff.ts`, `getTileData.ts` | Open a COG and read/decode tiles (with a module-level cache). |
| `renderTile.ts`, `renderPipeline.ts` | deck.gl-raster shader pipelines — RGB gain, NDVI/index math, colormaps. |
| `shaders/`, `cartoColormaps.ts`, `discardBlack.ts` | GLSL shader modules + colormap helpers. |
| `consoleCapture.ts` | Mirrors console errors/warnings into the in-panel log. |
| `geocode.ts`, `PlaceSearch.tsx`, `prefs.ts`, `loadStats.ts` | Search, persisted prefs, load scoreboard. |
| `raster/Elevated*.ts`, `elevation.ts` | **Dead code** from the abandoned Path B (hand-rolled mesh z-injection). Kept on the branch; safe to delete. |

### The stack

deck.gl 9.3 (`@deck.gl/core`, `/geo-layers` for `TerrainLayer`, `/extensions`
for `TerrainExtension`, `/mapbox` for the interleaved overlay) · luma.gl 9.3 ·
MapLibre GL 5 · react-map-gl 8 · React 19 · Vite. Imagery via Development Seed's
`@developmentseed/deck.gl-{raster,geotiff}` + `geotiff` (0.7). DEM meshing via
`@mapbox/martini`.

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
  + meshing happen on the main thread. Panning can stutter (worse since the
  terrain fetches z13 tiles via `tileSize: 256`). Moving it to a Web Worker is the
  next real perf win.
- **10 m only at z13+.** Zoom out past ~z12 and the terrain coarsens to 30 m
  glo30 (the finer data simply doesn't exist below z13).
- **Steep faces soften slightly.** Drape fidelity is bounded by the terrain mesh /
  cover-texture resolution, not the imagery.
- **Debug leftovers.** `clampedTerrainLoader.ts` still has a one-shot `parse() RAN`
  log and a `?demdebug` histogram mode. Harmless.

See `docs/` for the design history — `ROADMAP.md` (original plan + fallbacks),
`TERRAIN_DRAPE_PLAN.md` (the drape-mode fix), `TERRAIN_SPIKES_PLAN.md` (spike
debugging). Note `ROADMAP.md` predates the pivot to `TerrainLayer` +
`TerrainExtension`; this README reflects what's actually built.
