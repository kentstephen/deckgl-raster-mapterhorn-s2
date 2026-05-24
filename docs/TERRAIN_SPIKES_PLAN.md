# Plan — diagnose & fix terrain "needle" spikes (and confirm it stops crumpling)

## Context

On branch `terrain-extension-rebuild` we migrated off the hand-rolled terrain
(Path B) to deck `TerrainLayer` + `TerrainExtension`. That succeeded: the z12
crash, the demVersion rebuild-storm, the model-remount churn, and the z13
min-zoom cliff are gone, and S2 (RGB + NDVI/NDWI) drapes correctly.

TWO problems remain; this plan targets only them:

1. **Needle spikes** — thin vertical geometry quills across the mesh. A first
   attempt (absolute clamp `[-500, 9000]` m in `web/src/raster/clampedTerrainLoader.ts`)
   did NOT remove them.
2. **Jank** — confirmed slow/stuttery on pan/zoom but does NOT crash/freeze
   (no OOM). Step 3 is about frame-rate, not memory survival.

We have been patching speculatively. This plan is **measure first, fix second.**

PRIME PERF SUSPECT (self-inflicted): the clamping loader is registered
`worker: false`, so EVERY terrain tile decodes (262k-px loop) + medians + meshes
on the MAIN THREAD. A pan fires that for many tiles back-to-back → the jank.
The stock `TerrainWorkerLoader` did this off-thread. Moving our clamped loader
back onto a Web Worker is the likely jank fix (Step 3).

## Why the first fix failed

Absolute `[-500, 9000]` only catches extreme sentinels. The visible spikes are
pixels that jump a few thousand meters above their NEIGHBORS while staying in
band, so they pass the clamp. Old Path B "looked fine" only because it sampled
the DEM on a coarse ~35 m grid that averaged isolated bad pixels away; Martini
meshes at full pixel resolution and reproduces each outlier faithfully.

## Hypotheses (ranked; confirm, don't assume)

- **H0 — the clamp loader never ran.** Needles look identical to pre-fix. If
  deck didn't honor `loaders:[ClampedTerrainLoader]` (or Vite HMR served stale
  code), the stock `TerrainWorkerLoader` is still meshing and our clamp is dead
  code. Cheapest to check — FIRST.
- **H1 — single-pixel in-band outliers.** Needs a neighbor-relative despeckle /
  median, not an absolute clamp.
- **H2 — alpha/colorspace decode corruption.** `createImageBitmap` + canvas may
  premultiply alpha / convert colorspace, corrupting RGB at nodata pixels.
- **H3 — lossy-WebP ringing** near ridge/water edges.

## Step 0 — Confirm the loader actually runs (H0)

One-shot `console.log` in `clampedTerrainLoader.ts` `parse()`. Hard-reload, cache
disabled.
- **Not logged** → wiring/HMR issue. Trace `loaders` through
  `TerrainLayer.loadTerrain` → deck `fetch` (`terrain-layer.js:72-88`); register
  the loader / subclass `loadTerrain` if deck ignores per-layer `loaders`. May
  fix everything — re-evaluate before building a despeckle.
- **Logged** → mesher is live; go to Step 1.

## Step 1 — Characterize the spikes with real numbers

Instrument `parse()` for the first N tiles (then disable): over the decoded grid,
log min/max/median and the **count of pixels where `|e - median3x3| >
{500,1000,2000} m`**; note isolated (1px) vs clustered, and whether they coincide
with alpha=0 / RGB=(0,0,0). Dump one raw tile. Numbers pick the fix:
- isolated 1px, in-band → despeckle (2A)
- on alpha=0 / black → decode fix (2B)
- broad edge ringing → median still helps; revisit meshMaxError/source.

## Step 2 — Apply the data-driven fix

- **2A Despeckle (most likely):** before Martini, replace any pixel with
  `|e - median3x3| > T` by the local median (one cheap pass over 512²; kills
  isolated spikes, keeps real relief). Tune `T` from Step 1. Keep absolute clamp
  as backstop.
- **2B Decode hardening:** `createImageBitmap(blob,{premultiplyAlpha:'none',
  colorSpaceConversion:'none'})`; if alpha=0 marks nodata, neighbor-fill / zero
  those pixels before meshing.

## Step 3 — Kill the jank (confirmed: slow, not crashing)

Primary: **move the clamped decode/mesh off the main thread.** Simplest first:
(a) re-enable a worker for our loader (Vite worker entry; clamp + median is
portable JS); (b) if a custom worker loader is fiddly with Vite, keep
`worker:false` but cap concurrent decodes + `requestIdleCallback`-chunk the
per-tile loop so it can't monopolize a frame. Measure long-task durations during
a scripted pan before/after. Secondary: check `TerrainLayer` overzoom fan-out
(maxZoom 17 vs map zoom) and inner `TileLayer` cache size; raise `meshMaxError`
(4 → 8–12) to cut vertices if mesh upload is the cost. (No OOM hardening — no
crash.)

## Step 4 — Seams / skirts (only after spikes gone)

Our loader skips terrain-tile skirts. If hairline seams/voids appear between
tiles on close zoom, port `addSkirt` (loaders.gl `helpers/skirt.js`, MIT) using
the `skirtHeight` already in `options.terrain`.

## Critical files

- `web/src/raster/clampedTerrainLoader.ts` — instrumentation (0/1), despeckle
  (2A), decode flags (2B), skirts (4).
- `web/src/App.tsx` — `TerrainLayer` wiring (loaders, maxZoom, cache bounds).
- Reference: `node_modules/@deck.gl/geo-layers/dist/terrain-layer/terrain-layer.js`
  (`loadTerrain` 72-88), `node_modules/@loaders.gl/terrain/dist/lib/parse-terrain.js`.

## Verification

1. Loader logs confirm it runs (Step 0).
2. Step-1 outlier counts drop to ~0 after the fix.
3. Scripted pan+zoom: needle-free, no WebGL context loss, smooth (long-tasks
   gone after worker move).
4. Close-zoom pan across tile borders: no seams.
