# Plan — fix the drape (flat/glitchy extrusion + patchy viewport)

## Where we are (2026-05-24)

On `terrain-extension-rebuild` we run stock deck `TerrainLayer` (Mapterhorn
terrarium, `usgs3dep13` 10 m) + `TerrainExtension` on the deck.gl-raster imagery
layers, interleaved under maplibre. Resolved this session:

- **Needle spikes** — fixed by a neighbor-relative despeckle (5×5 median,
  `web/src/raster/clampedTerrainLoader.ts`), confirmed running via a one-shot log.
- **Black/magenta faces** — diagnosed (magenta-fill test) as the `terrain+draw`
  surface poking through the imagery; switched `operation` to `terrain`.
- **In-app copyable console** added (`web/src/consoleCapture.ts`).

Remaining: the drape is **flat, glitchy, and patchy across the viewport.**

## Root cause (confirmed against upstream)

`TerrainExtension` auto-selects its draw mode (terrain-extension.js:35):

```js
const is3d = this.props.extruded;
const hasAnchor = attributes && 'instancePositions' in attributes;
terrainDrawMode = is3d || hasAnchor ? 'offset' : 'drape';
```

deck.gl-raster renders imagery via `MeshTextureLayer` → `SimpleMeshLayer`, which
is **instanced** and exposes `instancePositions` ⇒ `hasAnchor = true` ⇒ we get
**`'offset'`** mode without ever asking for it.

Per deck docs (TerrainExtension):
- `'offset'` — *translates each object vertically by the terrain elevation at its
  anchor point*. Intended for icons/scatterplots. Applied to a COG mesh it shifts
  the whole (essentially flat) tile rigidly by one anchor's height → flat plates,
  per-tile height steps, glitch.
- `'drape'` — *overlays the layer as a texture onto the terrain surface; altitude
  and extrusion ignored*. This is what we want: imagery becomes a per-terrain-tile
  cover texture mapped onto the FINE terrain mesh, so it follows full relief.

So the earlier `terrain+draw` poke-through and the current flat/glitchy look are
the SAME underlying issue: the imagery was a competing 3D mesh, not a drape.

## The fix (primary)

Force drape mode and restore the drawn terrain surface so there is a mesh for the
cover to sit on and a dark fill where no imagery covers:

1. **`terrainDrawMode: 'drape'`** on each imagery layer (`MosaicLayer` props in
   `web/src/App.tsx`, both RGB and index paths). `terrainDrawMode` is a
   TerrainExtension prop merged into layer props and read as `this.props.
   terrainDrawMode`, so setting it on the layer is the supported override.
2. **Revert `operation` back to `'terrain+draw'`** (App.tsx:~213). With the
   imagery as a drape cover on the terrain mesh (not a separate offset mesh),
   `'draw'` no longer fights it — it just provides the surface + the
   `color: [38,42,46]` fill outside coverage. (If a subtle z-fight reappears,
   keep `'terrain'`; test both.)
3. Verify the imagery now hugs ridgelines/valleys (real relief, not plates) and
   the per-tile stepping/glitch is gone.

Open question to confirm during the fix: drape requires a per-tile cover render
(`terrain-cover.js getTile(targetLayer)`); confirm it works for the tiled
`COGLayer → RasterTileLayer → MeshTextureLayer` chain (deck discussion #7737
indicates TerrainExtension + TileLayer is supported). If the cover renders empty,
fall back to setting `terrainDrawMode` on the inner layer via the COGLayer's
sublayer props rather than the MosaicLayer wrapper.

## "Not loading the whole viewport"

Two independent contributors; separate them:

1. **Imagery coverage** — only the loaded COGs drape; the rest shows terrain fill.
   This is loading, not terrain. Already auto-fetched on `moveend`
   (`handleFetchViewport`). Confirm the AOI span cap (`MAX_VIEWPORT_SPAN_DEG=5`)
   and `minZoom=9` aren't starving the view, and that drape covers refresh when
   new COGs land.
2. **Terrain tile extent** — `TerrainLayer` is a `TileLayer`; it loads DEM tiles
   for the viewport on its own schedule. In `'offset'` mode, un-loaded terrain →
   zero offset → flat patches (looks like "not loading"). `'drape'` removes that
   coupling (the cover maps onto whatever terrain mesh exists). Re-evaluate after
   the drape fix; the symptom may simply disappear.

## Secondary / deferred (do NOT block the drape fix)

- **Tile seams** — user: minor. Port loaders.gl `addSkirt` into the clamped loader
  using `options.terrain.skirtHeight` (already passed). Plan Step 4 from
  `TERRAIN_SPIKES_PLAN.md`.
- **Main-thread jank** — despeckle/decode/Martini run `worker:false`. Move to a
  Vite worker entry, or cap concurrency + idle-chunk the per-tile loop. Only after
  the drape looks right.
- **Drape texture resolution** — if draped imagery looks soft, check the terrain
  cover / height-map size (`height-map-builder.js` MAP_MAX_SIZE) and terrain
  `meshMaxError` (currently 4).

## Verification

1. Imagery follows full relief (snow on faces, valleys recessed) — no flat plates,
   no per-tile height steps.
2. Pan/zoom is smooth; tiles fill the view without glitchy popping.
3. RGB and at least one spectral index both drape correctly (shared layer chain).
4. No regression of the needle spikes or the black/magenta faces.

## Files

- `web/src/App.tsx` — `terrainLayer` (`operation`), both `MosaicLayer` blocks
  (`terrainDrawMode`, `extensions`).
- `node_modules/@deck.gl/extensions/dist/terrain/{terrain-extension,terrain-cover,
  height-map-builder}.js` — reference for drape internals.
- `web/src/raster/clampedTerrainLoader.ts` — skirts (deferred), worker (deferred).
</content>
