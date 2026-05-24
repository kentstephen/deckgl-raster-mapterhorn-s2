/**
 * DEM sampling for the terrain mesh. Pulls Mapterhorn terrarium tiles
 * (`usgs3dep13`, 10 m over CONUS at z>=13; `glo30` 30 m fallback), decodes them
 * to meters, and answers point elevation queries with bilinear sampling.
 *
 * Mirrors the predecessor's module-level cache idiom (see loadGeotiff.ts): tiles
 * live in a module Map, NOT a layer cache, so repeated mesh builds reuse decoded
 * data. `elevationAt` is intentionally SYNCHRONOUS — the deck.gl-raster mesh
 * builder (`_generateMesh`) runs sync, so callers must `prefetchTilesForBounds`
 * first, then sample from the warm cache.
 */

const TILE_URL = (z: number, x: number, y: number) =>
  `https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`;

const DEM_TILE_SIZE = 512;

/**
 * Map zoom at/above which terrain renders. Set to 10 so you can pull back and
 * look DOWN at Mount Washington from a distance (not just from on top of it).
 * The DEM tile zoom (below) tracks the view, so zooming out doesn't explode the
 * tile count.
 */
export const TERRAIN_MIN_ZOOM = 10;
/** Mapterhorn serves usgs3dep13 (10 m) only at z>=13; below that it's glo30. */
export const DEM_MIN_ZOOM = 13;
/** 10 m detail saturates by ~z15; capping bounds tile counts and decode cost. */
export const TERRAIN_MAX_DEM_ZOOM = 15;

/**
 * What terrain does when the map is zoomed out past TERRAIN_MIN_ZOOM (below the
 * 10 m band). Single switch so it's a one-line change.
 *   "flat"  → terrain turns off; imagery lies flat (current default).
 *   "glo30" → keep terrain on, coarsening to Mapterhorn's 30 m glo30 (the same
 *             xyz endpoint serves it at low zoom). NOT wired yet — flipping here
 *             also needs demZoom to be allowed below 13.
 * TODO(Stephen): likely switch to "glo30" later.
 */
export type BelowMinZoomBehavior = "flat" | "glo30";
export const BELOW_MIN_ZOOM_BEHAVIOR: BelowMinZoomBehavior = "flat";

/** Whether terrain should be sampled at the given map zoom (honors the switch). */
export function terrainActiveAtZoom(mapZoom: number): boolean {
  if (mapZoom >= TERRAIN_MIN_ZOOM) return true;
  return BELOW_MIN_ZOOM_BEHAVIOR === "glo30";
}

const EARTH_RADIUS_M = 6378137;
const WEB_MERCATOR_MAX = Math.PI * EARTH_RADIUS_M; // 20037508.342789244

/**
 * Pick the DEM tile zoom for a given map zoom.
 * - Close in (map z>=12): pin to the 10 m band (z13–15) for full detail.
 * - Zoomed out (map z<12): let DEM zoom track the view (z10–12, Mapterhorn's
 *   coarser glo30), so a wide "look down" view doesn't pull thousands of z13
 *   tiles. You can't see 10 m detail from that far anyway.
 */
export function demZoomForMapZoom(mapZoom: number): number {
  const z = Math.round(mapZoom);
  // 10 m (usgs3dep13, z13+) from map zoom ~11.5 up; coarser glo30 only when
  // pulled well back. (Threshold 11 so a z11.7 "look down" view is still 10 m.)
  if (mapZoom >= 11) {
    return Math.max(DEM_MIN_ZOOM, Math.min(TERRAIN_MAX_DEM_ZOOM, z));
  }
  return Math.max(TERRAIN_MIN_ZOOM, Math.min(12, z));
}

// ---- coordinate helpers -----------------------------------------------------

export function mercatorToLngLat(x: number, y: number): [number, number] {
  const lng = (x / WEB_MERCATOR_MAX) * 180;
  const lat =
    (Math.atan(Math.exp((y / WEB_MERCATOR_MAX) * Math.PI)) * 360) / Math.PI - 90;
  return [lng, lat];
}

/** Fractional slippy-tile coords for a lon/lat at zoom z. */
function lngLatToTileXY(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
  return [x, y];
}

// ---- tile cache -------------------------------------------------------------

const cache = new Map<string, Float32Array>();
const inflight = new Map<string, Promise<Float32Array | null>>();

const key = (z: number, x: number, y: number) => `${z}/${x}/${y}`;

// Listeners notified when a new DEM tile finishes decoding. The app subscribes
// and bumps a `demVersion` so deck re-renders and the live elevated layer
// rebuilds its mesh with the now-warm cache (see ElevatedRasterLayer).
const tileLoadListeners = new Set<() => void>();
export function subscribeDemTiles(fn: () => void): () => void {
  tileLoadListeners.add(fn);
  return () => tileLoadListeners.delete(fn);
}
function notifyTileLoaded() {
  for (const fn of tileLoadListeners) fn();
}

/** Decode one terrarium tile to a Float32Array of meters (row-major, 512x512). */
async function fetchTerrainTile(
  z: number,
  x: number,
  y: number,
): Promise<Float32Array | null> {
  const k = key(z, x, y);
  const cached = cache.get(k);
  if (cached) return cached;
  const pending = inflight.get(k);
  if (pending) return pending;

  const p = (async () => {
    try {
      const res = await fetch(TILE_URL(z, x, y));
      if (!res.ok) return null;
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(DEM_TILE_SIZE, DEM_TILE_SIZE);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE);
      bitmap.close();
      const { data } = ctx.getImageData(0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE);
      const elev = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
      for (let i = 0; i < elev.length; i++) {
        const r = data[i * 4];
        const g = data[i * 4 + 1];
        const b = data[i * 4 + 2];
        // terrarium decode
        const e = r * 256 + g + b / 256 - 32768;
        // Reject no-data / sentinel / absurd values (ocean fill, tile seams,
        // terrarium -32768) so they can't spike into needles when exaggerated.
        elev[i] = e < -500 || e > 9000 ? 0 : e;
      }
      cache.set(k, elev);
      notifyTileLoaded();
      return elev;
    } catch {
      return null;
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

/**
 * Ensure every DEM tile covering a Web-Mercator bounds is decoded into cache.
 * Resolves once all are loaded (or failed). `bounds3857` is [minX,minY,maxX,maxY].
 */
export async function prefetchTilesForBounds(
  bounds3857: [number, number, number, number],
  z: number,
): Promise<void> {
  const [minX, minY, maxX, maxY] = bounds3857;
  const [w, n] = mercatorToLngLat(minX, maxY); // top-left
  const [e, s] = mercatorToLngLat(maxX, minY); // bottom-right
  const [tx0, ty0] = lngLatToTileXY(w, n, z);
  const [tx1, ty1] = lngLatToTileXY(e, s, z);
  const xMin = Math.floor(Math.min(tx0, tx1));
  const xMax = Math.floor(Math.max(tx0, tx1));
  const yMin = Math.floor(Math.min(ty0, ty1));
  const yMax = Math.floor(Math.max(ty0, ty1));
  const jobs: Promise<unknown>[] = [];
  for (let tx = xMin; tx <= xMax; tx++) {
    for (let ty = yMin; ty <= yMax; ty++) {
      jobs.push(fetchTerrainTile(z, tx, ty));
    }
  }
  await Promise.all(jobs);
}

/**
 * Elevation in meters at lon/lat, bilinearly sampled from the DEM tile at zoom
 * z. SYNCHRONOUS: returns 0 if the covering tile isn't cached yet (caller must
 * prefetch first). Samples clamp within the tile; cross-tile edges are handled
 * by sampling consistent coords (see seam handling in the mesh builder).
 */
export function elevationAt(lng: number, lat: number, z: number): number {
  const [fx, fy] = lngLatToTileXY(lng, lat, z);
  const tx = Math.floor(fx);
  const ty = Math.floor(fy);
  const tile = cache.get(key(z, tx, ty));
  if (!tile) return 0;

  // pixel position within the tile (0..DEM_TILE_SIZE)
  const px = (fx - tx) * DEM_TILE_SIZE;
  const py = (fy - ty) * DEM_TILE_SIZE;
  const x0 = Math.min(DEM_TILE_SIZE - 1, Math.max(0, Math.floor(px)));
  const y0 = Math.min(DEM_TILE_SIZE - 1, Math.max(0, Math.floor(py)));
  const x1 = Math.min(DEM_TILE_SIZE - 1, x0 + 1);
  const y1 = Math.min(DEM_TILE_SIZE - 1, y0 + 1);
  const dx = px - x0;
  const dy = py - y0;

  const e00 = tile[y0 * DEM_TILE_SIZE + x0];
  const e10 = tile[y0 * DEM_TILE_SIZE + x1];
  const e01 = tile[y1 * DEM_TILE_SIZE + x0];
  const e11 = tile[y1 * DEM_TILE_SIZE + x1];
  const top = e00 + (e10 - e00) * dx;
  const bot = e01 + (e11 - e01) * dx;
  return top + (bot - top) * dy;
}

/** True if the covering tile for this point is already decoded. */
export function hasTileFor(lng: number, lat: number, z: number): boolean {
  const [fx, fy] = lngLatToTileXY(lng, lat, z);
  return cache.has(key(z, Math.floor(fx), Math.floor(fy)));
}
