/**
 * A drop-in replacement for `@loaders.gl/terrain`'s TerrainWorkerLoader that
 * DESPECKLES decoded elevations before meshing.
 *
 * Why: Mapterhorn ships terrarium tiles as WebP. A handful of pixels per tile
 * (nodata at water / coverage edges, compression outliers) decode to elevations
 * that jump thousands of meters away from their NEIGHBORS — sometimes outside
 * any plausible band, often inside it. loaders.gl's decoder is purely linear and
 * passes them straight through (`parse-terrain.js`: `r*rScaler + g*gScaler +
 * b*bScaler + offset`, no clean-up), so each becomes a vertical "needle" spike;
 * the draped imagery stretched over that near-vertical wall samples to garbage
 * and renders as a BLACK sliver.
 *
 * An earlier version clamped to an absolute band and set outliers to 0 m. That
 * was wrong twice: (1) an absolute `[-500, 9000]` band never catches the in-band
 * outliers (a pixel at 5000 m amid 2000 m terrain passes it), and (2) slamming a
 * nodata pixel in the middle of 2000 m terrain to 0 m just turns an up-needle
 * into an equally-tall DOWN-needle (a vertical wall to sea level) — same black
 * artifact, opposite direction. The fix has to be NEIGHBOR-RELATIVE: any pixel
 * more than `DESPECKLE_T` meters from its 3×3 median is replaced by that median.
 * That removes isolated up/down spikes while preserving real relief. The
 * absolute band is kept only as a coarse backstop (extreme nodata sentinels).
 *
 * The meshing (Martini) + attribute/skirt logic is a faithful copy of
 * loaders.gl `parse-terrain.js` (MIT, vis.gl contributors). Runs on the main
 * thread (worker:false); Martini is fast and this runs once per tile (TileLayer
 * caches), not per frame. (Moving this off-thread is the separate jank fix.)
 *
 * Exaggeration handling: App folds the slider value `k` into the elevationDecoder
 * (each scaler × k) so the decoder identity changes → TerrainLayer reloads → the
 * slider is live. That means decoded values arrive as `realMeters × k`. We
 * recover `k = rScaler / 256` (true terrarium rScaler is 256) so both the
 * despeckle threshold and the absolute band are applied in REAL meters at any
 * exaggeration.
 */

import Martini from "@mapbox/martini";

// Real-world elevation band; anything outside is an extreme nodata sentinel,
// flagged for neighbor-fill (NOT forced to 0 — that creates its own needle).
const MIN_ELEV_M = -500;
const MAX_ELEV_M = 9000;

// Neighbor-relative despeckle threshold (REAL meters). A pixel whose elevation
// differs from the window median by more than this is treated as a spike and
// replaced by the median. Tune from the ?demdebug histogram; 300 m is a
// conservative start (real terrain rarely jumps >300 m across one 10 m pixel —
// that's a >88% slope).
const DESPECKLE_T = 120;

// Number of median-replace passes. Iterating dissolves clustered spikes (lossy-
// WebP ringing) that a single pass leaves behind. 3 handles clusters several
// pixels wide; clean terrain is unaffected.
const DESPECKLE_PASSES = 3;

// Median window radius. r=1 → 3×3 (9 samples), r=2 → 5×5 (25 samples). A 3×3
// median is polluted when ≥half its samples are bad — i.e. it fails on CLUSTERS
// of spikes and at tile edges (few valid neighbors). r=2 tolerates up to ~12 bad
// samples, so it survives small clusters. Heavier per pixel; revisit if jank.
const DESPECKLE_R = 2;

// `?demdebug` logs per-tile elevation stats + outlier histograms for the first
// few tiles, so the threshold can be set from real numbers. Off by default.
const DEBUG =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).has("demdebug");
const DEBUG_TILE_LIMIT = 4;
let debugTilesLogged = 0;

type ElevationDecoder = {
  rScaler: number;
  gScaler: number;
  bScaler: number;
  offset: number;
};

type TerrainOptions = {
  meshMaxError: number;
  bounds: [number, number, number, number];
  elevationDecoder: ElevationDecoder;
  skirtHeight?: number;
};

async function decodeImage(
  arrayBuffer: ArrayBuffer,
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const bitmap = await createImageBitmap(new Blob([arrayBuffer]));
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, width, height);
  return { data, width, height };
}

// Median of a small (≤9) Float32 sample, ignoring NaN. Mutates a scratch slice.
function medianOf(values: number[], n: number): number {
  // n = count of valid entries packed at the front of `values`.
  if (n === 0) return 0;
  // Insertion sort — n ≤ 9, so this is cheaper than allocating + Array.sort.
  for (let i = 1; i < n; i++) {
    const v = values[i];
    let j = i - 1;
    while (j >= 0 && values[j] > v) {
      values[j + 1] = values[j];
      j--;
    }
    values[j + 1] = v;
  }
  return n & 1 ? values[(n - 1) >> 1] : (values[n / 2 - 1] + values[n / 2]) / 2;
}

// Decode terrarium pixels and DESPECKLE: replace any pixel that differs from its
// 3×3 median by more than DESPECKLE_T (real meters) — or that fell outside the
// absolute band — with the local median. Returns the martini-padded grid.
function getTerrainClamped(
  imageData: Uint8ClampedArray,
  width: number,
  height: number,
  decoder: ElevationDecoder,
): Float32Array {
  const { rScaler, gScaler, bScaler, offset } = decoder;
  // Exaggeration is folded into the decoder (rScaler = 256 × k). Recover k so
  // thresholds apply in real meters; guard k=0 (degenerate) → div-by-zero.
  const k = rScaler / 256 || 1;
  const tHi = DESPECKLE_T * k; // threshold in decoded (exaggerated) units
  const minE = MIN_ELEV_M * k;
  const maxE = MAX_ELEV_M * k;

  // 1. Decode to a clean width×height grid in decoded units. Extreme-band pixels
  //    become NaN so they're ignored by the median and always get filled.
  const raw = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const c = i * 4;
    const e = imageData[c] * rScaler + imageData[c + 1] * gScaler +
      imageData[c + 2] * bScaler + offset;
    raw[i] = e < minE || e > maxE ? NaN : e;
  }

  if (DEBUG && debugTilesLogged < DEBUG_TILE_LIMIT) logTileStats(raw, imageData, width, height, k);

  // 2. Despeckle: repeated passes of conditional median-replace. A single pass
  //    can't fix CLUSTERS of bad pixels (lossy-WebP ringing along ridge edges)
  //    because >half the window is then bad and the median is itself polluted.
  //    Iterating fixes it: each pass cleans the cluster's outer ring (its window
  //    now has enough good neighbors), so clusters dissolve from the edges in.
  //    Clean terrain is untouched (|v − med| ≤ T keeps the original value).
  //    Double-buffered so a pass reads a stable grid.
  const r = DESPECKLE_R;
  const nbr: number[] = new Array((2 * r + 1) * (2 * r + 1));
  let cur = raw;
  for (let pass = 0; pass < DESPECKLE_PASSES; pass++) {
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        let nn = 0;
        for (let dy = -r; dy <= r; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const nv = cur[yy * width + xx];
            if (!Number.isNaN(nv)) nbr[nn++] = nv;
          }
        }
        const med = medianOf(nbr, nn);
        const v = cur[idx];
        out[idx] = !Number.isNaN(v) && Math.abs(v - med) <= tHi ? v : med;
      }
    }
    cur = out;
  }

  // 3. Write the cleaned grid into the martini-padded grid, which is
  //    (width+1)×(height+1) with each row shifted by +1 (loaders.gl convention)
  //    to leave room for the backfilled right-border column. Then backfill the
  //    bottom + right borders (Martini needs a power-of-two+1 grid).
  const terrain = new Float32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      terrain[y * width + x + y] = cur[y * width + x];
    }
  }
  for (let i = (width + 1) * width, x = 0; x < width; x++, i++) {
    terrain[i] = terrain[i - width - 1];
  }
  for (let i = height, y = 0; y < height + 1; y++, i += height + 1) {
    terrain[i] = terrain[i - 1];
  }
  return terrain;
}

// Diagnostics for ?demdebug: min/max/median, spike histogram vs the 3×3 median,
// and how many spikes coincide with alpha=0 / RGB=(0,0,0) (nodata signatures).
function logTileStats(
  raw: Float32Array,
  imageData: Uint8ClampedArray,
  width: number,
  height: number,
  k: number,
) {
  debugTilesLogged++;
  const valid: number[] = [];
  for (let i = 0; i < raw.length; i++) if (!Number.isNaN(raw[i])) valid.push(raw[i] / k);
  valid.sort((a, b) => a - b);
  const med = valid.length ? valid[valid.length >> 1] : 0;
  const buckets = [500, 1000, 2000];
  const counts = [0, 0, 0];
  let onAlpha0 = 0;
  let onBlack = 0;
  let outOfBand = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const v = raw[idx];
      const c = idx * 4;
      const a = imageData[c + 3];
      const isBlack = imageData[c] === 0 && imageData[c + 1] === 0 && imageData[c + 2] === 0;
      if (Number.isNaN(v)) {
        outOfBand++;
        if (a === 0) onAlpha0++;
        if (isBlack) onBlack++;
        continue;
      }
      // Local median (real meters) — reuse a quick 3×3 scan.
      const nb: number[] = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= height || xx < 0 || xx >= width) continue;
          const nv = raw[yy * width + xx];
          if (!Number.isNaN(nv)) nb.push(nv / k);
        }
      nb.sort((p, q) => p - q);
      const m = nb[nb.length >> 1];
      const d = Math.abs(v / k - m);
      for (let b = 0; b < buckets.length; b++) if (d > buckets[b]) counts[b]++;
      if (d > buckets[0]) {
        if (a === 0) onAlpha0++;
        if (isBlack) onBlack++;
      }
    }
  }
  console.info(
    `[demdebug] tile ${debugTilesLogged}/${DEBUG_TILE_LIMIT} ${width}×${height} ` +
      `min=${valid[0]?.toFixed(0)} max=${valid[valid.length - 1]?.toFixed(0)} median=${med.toFixed(0)} m | ` +
      `spikes |Δmed|> ${buckets.join("/")} m = ${counts.join("/")} | ` +
      `outOfBand=${outOfBand} | on alpha=0: ${onAlpha0}, on RGB=000: ${onBlack} | ` +
      `T=${DESPECKLE_T} m`,
  );
}

function getMeshAttributes(
  vertices: Uint16Array,
  terrain: Float32Array,
  width: number,
  height: number,
  bounds: [number, number, number, number],
) {
  const gridSize = width + 1;
  const numOfVerticies = vertices.length / 2;
  const positions = new Float32Array(numOfVerticies * 3);
  const texCoords = new Float32Array(numOfVerticies * 2);
  const [minX, minY, maxX, maxY] = bounds;
  const xScale = (maxX - minX) / width;
  const yScale = (maxY - minY) / height;
  for (let i = 0; i < numOfVerticies; i++) {
    const x = vertices[i * 2];
    const y = vertices[i * 2 + 1];
    const pixelIdx = y * gridSize + x;
    positions[3 * i] = x * xScale + minX;
    positions[3 * i + 1] = -y * yScale + maxY;
    positions[3 * i + 2] = terrain[pixelIdx];
    texCoords[2 * i] = x / width;
    texCoords[2 * i + 1] = y / height;
  }
  return {
    POSITION: { value: positions, size: 3 },
    TEXCOORD_0: { value: texCoords, size: 2 },
  };
}

function boundingBox(positions: Float32Array): [number[], number[]] {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const v = positions[i + j];
      if (v < min[j]) min[j] = v;
      if (v > max[j]) max[j] = v;
    }
  }
  return [min, max];
}

type MeshAttributes = {
  POSITION: { value: Float32Array; size: number };
  TEXCOORD_0: { value: Float32Array; size: number };
};

function concatF32(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatU32(a: Uint32Array, b: Uint32Array): Uint32Array {
  const out = new Uint32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Faithful port of loaders.gl helpers/skirt.js (MIT). Finds the mesh's outer
// edges and drops a vertical wall (skirt) of `skirtHeight` along them, so the
// hairline cracks between adjacent terrain tiles (slightly mismatched edge z, or
// LOD-boundary XY gaps) are hidden behind the apron instead of showing the
// basemap/void through. The stock TerrainWorkerLoader does this; our loader had
// dropped it. Martini gives no quantized edge indices, so edges are derived from
// the triangles (an edge shared by 2 triangles is interior; unshared = border).
function getOutsideEdgesFromTriangles(triangles: Uint32Array): number[][] {
  const edges: number[][] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    edges.push([triangles[i], triangles[i + 1]]);
    edges.push([triangles[i + 1], triangles[i + 2]]);
    edges.push([triangles[i + 2], triangles[i]]);
  }
  edges.sort(
    (a, b) => Math.min(...a) - Math.min(...b) || Math.max(...a) - Math.max(...b),
  );
  const outside: number[][] = [];
  let i = 0;
  while (i < edges.length) {
    if (
      edges[i][0] === edges[i + 1]?.[1] &&
      edges[i][1] === edges[i + 1]?.[0]
    ) {
      i += 2;
    } else {
      outside.push(edges[i]);
      i++;
    }
  }
  return outside;
}

function addSkirt(
  attributes: MeshAttributes,
  triangles: Uint32Array,
  skirtHeight: number,
): { attributes: MeshAttributes; triangles: Uint32Array } {
  const outsideEdges = getOutsideEdgesFromTriangles(triangles);
  const pos = attributes.POSITION.value;
  const uv = attributes.TEXCOORD_0.value;
  const newPosition = new Float32Array(outsideEdges.length * 6);
  const newTexcoord0 = new Float32Array(outsideEdges.length * 4);
  const newTriangles = new Uint32Array(outsideEdges.length * 6);
  const positionsLength = pos.length;
  for (let ei = 0; ei < outsideEdges.length; ei++) {
    const edge = outsideEdges[ei];
    const v1 = ei * 2;
    const v2 = ei * 2 + 1;
    // New apron vertices: copy the edge endpoints, drop z by skirtHeight.
    newPosition.set(pos.subarray(edge[0] * 3, edge[0] * 3 + 3), v1 * 3);
    newPosition[v1 * 3 + 2] -= skirtHeight;
    newPosition.set(pos.subarray(edge[1] * 3, edge[1] * 3 + 3), v2 * 3);
    newPosition[v2 * 3 + 2] -= skirtHeight;
    newTexcoord0.set(uv.subarray(edge[0] * 2, edge[0] * 2 + 2), v1 * 2);
    newTexcoord0.set(uv.subarray(edge[1] * 2, edge[1] * 2 + 2), v2 * 2);
    const t = ei * 2 * 3;
    newTriangles[t] = edge[0];
    newTriangles[t + 1] = positionsLength / 3 + v2;
    newTriangles[t + 2] = edge[1];
    newTriangles[t + 3] = positionsLength / 3 + v2;
    newTriangles[t + 4] = edge[0];
    newTriangles[t + 5] = positionsLength / 3 + v1;
  }
  attributes.POSITION.value = concatF32(pos, newPosition);
  attributes.TEXCOORD_0.value = concatF32(uv, newTexcoord0);
  return { attributes, triangles: concatU32(triangles, newTriangles) };
}

// One-shot proof-of-life: confirms deck actually routes terrain tiles through
// THIS loader (plan H0) rather than the stock TerrainWorkerLoader. Fires once,
// regardless of ?demdebug. If you never see it, the loader is dead code and no
// amount of despeckling matters — the wiring is the bug.
let provedAlive = false;

async function parse(arrayBuffer: ArrayBuffer, options: any) {
  if (!provedAlive) {
    provedAlive = true;
    console.warn("[ClampedTerrainLoader] parse() RAN — loader is wired in ✅");
  }
  const t: TerrainOptions = options?.terrain ?? options;
  const { data, width, height } = await decodeImage(arrayBuffer);
  const terrain = getTerrainClamped(data, width, height, t.elevationDecoder);

  const martini = new Martini(width + 1);
  const tile = martini.createTile(terrain);
  const { vertices, triangles } = tile.getMesh(t.meshMaxError);

  let attributes: MeshAttributes = getMeshAttributes(vertices, terrain, width, height, t.bounds);
  // Bounding box BEFORE the skirt so the dropped apron z doesn't skew it
  // (matches loaders.gl parse-terrain.js ordering).
  const bbox = boundingBox(attributes.POSITION.value);

  let indexTriangles: Uint32Array = Uint32Array.from(triangles);
  if (t.skirtHeight) {
    // skirtHeight arrives in the SAME units as our z (decoded = realMeters × k),
    // since TerrainLayer derives it from meshMaxError — no extra scaling needed.
    const skirted = addSkirt(attributes, indexTriangles, t.skirtHeight);
    attributes = skirted.attributes;
    indexTriangles = skirted.triangles;
  }

  return {
    loaderData: { header: {} },
    header: {
      vertexCount: indexTriangles.length,
      boundingBox: bbox,
    },
    mode: 4, // GL.TRIANGLES
    indices: { value: indexTriangles, size: 1 },
    attributes,
  };
}

/** Same descriptor shape as loaders.gl TerrainLoader, but main-thread + despeckled. */
export const ClampedTerrainLoader = {
  name: "Despeckled Terrain",
  id: "despeckled-terrain",
  module: "terrain",
  version: "1.0.0",
  worker: false,
  extensions: ["png", "pngraw", "jpg", "jpeg", "gif", "webp", "bmp"],
  mimeTypes: [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
  ],
  parse,
  options: {
    terrain: {
      tesselator: "martini",
      bounds: undefined,
      meshMaxError: 10,
      elevationDecoder: { rScaler: 1, gScaler: 0, bScaler: 0, offset: 0 },
      skirtHeight: undefined,
    },
  },
};
