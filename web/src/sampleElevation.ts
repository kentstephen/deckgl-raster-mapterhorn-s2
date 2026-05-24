/**
 * Lightweight elevation sampler for the "Ground Level" datum shift.
 *
 * Fetches + terrarium-decodes Mapterhorn tiles and bilinear-samples points, so
 * App can find the lowest elevation in view and subtract it from the terrain
 * decoder (keeping high-altitude terrain sitting near z=0 → manageable camera +
 * less extruded-tile culling). Independent of the dead Path-B elevation.ts;
 * called only on moveEnd (debounced by the gesture), so a tiny bounded cache and
 * full-tile decode are fine.
 */

const TILE_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
const SAMPLE_Z = 13; // 10 m usgs3dep13; matches the terrain detail we render
const TILE_SIZE = 512;
const MAX_CACHED = 24;

// Decoded terrarium height grids, keyed "z/x/y". Bounded LRU.
const cache = new Map<string, Float32Array | null>();
const pending = new Map<string, Promise<Float32Array | null>>();

function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number; fx: number; fy: number } {
  const n = 2 ** z;
  const fx = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x: Math.floor(fx), y: Math.floor(fy), fx, fy };
}

async function fetchTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const k = `${z}/${x}/${y}`;
  if (cache.has(k)) return cache.get(k)!;
  const inflight = pending.get(k);
  if (inflight) return inflight;

  const p = (async () => {
    try {
      const url = TILE_URL.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
      const res = await fetch(url);
      if (!res.ok) return null;
      const bitmap = await createImageBitmap(await res.blob());
      const w = bitmap.width;
      const h = bitmap.height;
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const { data, width, height } = ctx.getImageData(0, 0, w, h);
      const grid = new Float32Array(width * height);
      for (let i = 0; i < width * height; i++) {
        const c = i * 4;
        grid[i] = data[c] * 256 + data[c + 1] + data[c + 2] / 256 - 32768;
      }
      return grid;
    } catch {
      return null;
    }
  })();

  pending.set(k, p);
  const grid = await p;
  pending.delete(k);
  // LRU insert (delete-then-set keeps insertion order = recency).
  cache.delete(k);
  cache.set(k, grid);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return grid;
}

async function elevationAt(lng: number, lat: number): Promise<number | null> {
  const { x, y, fx, fy } = lngLatToTile(lng, lat, SAMPLE_Z);
  const grid = await fetchTile(SAMPLE_Z, x, y);
  if (!grid) return null;
  // Nearest-pixel sample within the tile (bilinear is overkill for a datum base).
  const px = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor((fx - x) * TILE_SIZE)));
  const py = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor((fy - y) * TILE_SIZE)));
  const e = grid[py * TILE_SIZE + px];
  // Guard nodata sentinels (out of plausible band).
  return e < -500 || e > 9000 ? null : e;
}

/**
 * Minimum elevation (m) across the given points, ignoring any that fail to
 * sample (nodata / fetch error). Returns null if none sampled.
 */
export async function sampleMinElevation(points: [number, number][]): Promise<number | null> {
  const results = await Promise.all(points.map(([lng, lat]) => elevationAt(lng, lat)));
  let min = Infinity;
  for (const e of results) if (e !== null && e < min) min = e;
  return min === Infinity ? null : min;
}
