/**
 * Direct reader for Mapterhorn's regional terrain PMTiles archives on Source
 * Cooperative — the z13+ (10 m usgs3dep over CONUS) detail tiles.
 *
 * WHY (the "min-zoom problem"): holding 10 m relief across a zoomed-out frame
 * needs hundreds of z13 tiles. Fetching them one-at-a-time over the xyz endpoint
 * (tiles.mapterhorn.com/{z}/{x}/{y}.webp) is throttled by deck's maxRequests
 * (default 6), so the frame never settles. Mapterhorn also publishes the same
 * tiles as static PMTiles archives — one bundle per ~622 km z6 region — which we
 * range-read directly. PMTiles tiles are Hilbert-contiguous, so reads coalesce
 * and the per-request bottleneck disappears.
 *
 * Layout (from .../mapterhorn/mapterhorn/download_urls.json, verified 2026-05-25):
 *   - planet.pmtiles            global z0-12 (glo30 30 m base, 705 GB) — NOT used
 *                               here; the z<=12 base stays on the xyz endpoint.
 *   - {6-x-y}.pmtiles           regional, partitioned by z6 tile, z13-16/17.
 * Base (CORS-open mirror, Access-Control-Allow-Origin: *, range reads → 206):
 *   https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/mapterhorn/mapterhorn/
 *
 * Tiles are identical webp terrarium bytes to the xyz endpoint, so the existing
 * ClampedTerrainLoader decodes them unchanged (despeckle + skirts preserved).
 */
import { PMTiles, FetchSource } from "pmtiles";

const SOURCE_COOP_BASE =
  "https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/mapterhorn/mapterhorn/";

// Global z0-12 base archive (glo30 30 m terrarium). 705 GB, but range-read like
// any PMTiles: header + a 6.6 KB root directory on open, leaf dirs + tile bytes
// fetched on demand. Serving the base from here (instead of the per-tile xyz CDN
// tiles.mapterhorn.com) puts ALL terrain on the same source.coop range-read path
// — coalesced reads, shared directory cache, one consistent host.
const PLANET_ARCHIVE = "planet.pmtiles";

/** One regional archive's coverage, from download_urls.json. */
interface ArchiveEntry {
  name: string; // e.g. "6-11-24.pmtiles"
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  minZoom: number;
  maxZoom: number;
}

// Index of regional (z13+) archives, keyed by name. Fetched once, lazily.
let archiveIndex: Map<string, ArchiveEntry> | null = null;
let indexPromise: Promise<Map<string, ArchiveEntry>> | null = null;

// Lazily-opened PMTiles instances, one per regional archive. PMTiles caches the
// directory + coalesces range reads internally, so reuse is the whole point.
const pmtilesCache = new Map<string, PMTiles>();

/** Fetch + cache the regional-archive index (entries with z13+ detail). */
async function loadIndex(): Promise<Map<string, ArchiveEntry>> {
  if (archiveIndex) return archiveIndex;
  if (indexPromise) return indexPromise;
  indexPromise = (async () => {
    const res = await fetch(`${SOURCE_COOP_BASE}download_urls.json`);
    const json = (await res.json()) as {
      items: Array<{
        name: string;
        min_lon: number;
        min_lat: number;
        max_lon: number;
        max_lat: number;
        min_zoom: number;
        max_zoom: number;
      }>;
    };
    const idx = new Map<string, ArchiveEntry>();
    for (const it of json.items) {
      // Regional detail archives only (skip planet.pmtiles, which is z0-12).
      if (it.name === "planet.pmtiles" || it.min_zoom < 13) continue;
      idx.set(it.name, {
        name: it.name,
        minLon: it.min_lon,
        minLat: it.min_lat,
        maxLon: it.max_lon,
        maxLat: it.max_lat,
        minZoom: it.min_zoom,
        maxZoom: it.max_zoom,
      });
    }
    archiveIndex = idx;
    return idx;
  })();
  return indexPromise;
}

/**
 * Name of the regional archive holding tile (z,x,y): its z6 ancestor. Archives
 * are partitioned by z6 tile, so shift the tile coords down to z6.
 */
function archiveNameFor(z: number, x: number, y: number): string {
  const shift = z - 6;
  const x6 = x >> shift;
  const y6 = y >> shift;
  return `6-${x6}-${y6}.pmtiles`;
}

/** Get (lazily open) the PMTiles instance for a regional archive. */
function getArchive(name: string): PMTiles {
  let pm = pmtilesCache.get(name);
  if (!pm) {
    pm = new PMTiles(new FetchSource(`${SOURCE_COOP_BASE}${name}`));
    pmtilesCache.set(name, pm);
  }
  return pm;
}

/**
 * Read one terrarium tile directly from source.coop. z<=12 comes from the global
 * planet.pmtiles base (glo30 30 m); z>=13 from the covering regional archive
 * (usgs3dep 10 m over CONUS). Returns the raw bytes for ClampedTerrainLoader, or
 * null if the tile isn't present (water / edge / beyond the region's max zoom /
 * no coverage) — the caller treats null as "no terrain here" (flat).
 */
export async function readTerrainTile(
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer | null> {
  // z<=12 base: global planet archive, no index lookup needed (covers z0-12
  // everywhere). null (e.g. ocean) → flat, which is correct.
  if (z <= 12) {
    const resp = await getArchive(PLANET_ARCHIVE).getZxy(z, x, y, signal);
    return resp?.data ?? null;
  }
  const idx = await loadIndex();
  const name = archiveNameFor(z, x, y);
  const entry = idx.get(name);
  // No archive for this region, or zoomed past what the region carries.
  if (!entry || z > entry.maxZoom) return null;
  const resp = await getArchive(name).getZxy(z, x, y, signal);
  return resp?.data ?? null;
}
