import { RasterLayer } from "@developmentseed/deck.gl-raster";
import {
  elevationAt,
  hasTileFor,
  mercatorToLngLat,
  prefetchTilesForBounds,
} from "../elevation";

/**
 * `RasterLayer` that bakes real DEM elevation into the reprojection mesh.
 *
 * Upstream `RasterLayer._generateMesh()` builds an adaptive reprojection mesh
 * and hardcodes every vertex z to 0 (raster-layer.js:181). We reimplement that
 * step: each vertex's 3857 x,y is converted to lon/lat and given
 * `z = elevationAt() * WEB_MERCATOR_TO_WORLD_SCALE * exaggeration`.
 *
 * Why the scale factor: RasterTileLayer renders this mesh with a modelMatrix
 * that scales x,y from 3857 meters into deck's 512-unit world space, but leaves
 * z at scale 1. So we must pre-scale z by the same factor to keep relief
 * proportional to the horizontal extent.
 *
 * `_generateMesh` is synchronous, so on a DEM cache miss we build flat, kick off
 * a prefetch, and rebuild once tiles land.
 */

// Regular-grid tessellation per COG tile (segments per axis). 64 → 4225
// verts/tile. 128 looked smooth but hit ~1.4 GB / froze — though most of that was
// a layer leak (now fixed via getSubLayerProps), so 64 should be safe and far
// less blocky than 32. Detail also sharpens as you zoom in (tiles get smaller).
// TODO: tie grid to DEM resolution for true 10 m if 64 still reads coarse.
const TERRAIN_GRID = 64;

export class ElevatedRasterLayer extends RasterLayer {
  static layerName = "ElevatedRasterLayer";
  static defaultProps = {
    ...(RasterLayer as any).defaultProps,
    exaggeration: { type: "number", value: 1.5 },
    demZoom: { type: "number", value: 13 },
    terrainEnabled: { type: "boolean", value: true },
    // Bumped when new DEM tiles decode → forces a mesh rebuild against the warm
    // cache (the signature includes it, since the cache contents themselves
    // aren't a prop).
    demVersion: { type: "number", value: 0 },
  };

  // Signature of every input that affects mesh geometry (incl. elevation).
  // Stored in `state` (not an instance field) so deck carries it across the
  // layer-instance swap on each render — otherwise we'd rebuild every frame.
  private _sig(): string {
    const p = this.props as any;
    const f = p.reprojectionFns ?? {};
    return [
      p.terrainEnabled,
      p.exaggeration,
      p.demZoom,
      p.demVersion,
      p.width,
      p.height,
      p.maxError,
      // function identities (stable across renders for a given tile)
      f.forwardTransform,
      f.inverseTransform,
      f.forwardReproject,
      f.inverseReproject,
    ]
      .map((v) => (typeof v === "function" ? "fn" : String(v)))
      .join("|");
  }

  updateState(params: any) {
    super.updateState(params);
    // Rebuild exactly once whenever ANY mesh input changed — including the
    // elevation props (exaggeration/flat/demZoom), which are NOT super's
    // triggers. Signature dedupe avoids predicting super's internal decision
    // (and the reprojectionFns-by-reference churn that broke the old guard).
    const sig = this._sig();
    if (sig !== (this.state as any)?.meshSig) {
      this._generateMesh();
    }
  }

  // Overrides RasterLayer._generateMesh (same shape, elevated z).
  _generateMesh() {
    const {
      width,
      height,
      reprojectionFns,
      exaggeration,
      demZoom,
      terrainEnabled,
    } = this.props as any;
    const { forwardTransform, forwardReproject } = reprojectionFns;
    // z is in the SAME units as the mesh x,y (EPSG:3857 meters): the constant-z
    // spike proved raw-meter z (~3000) renders as visible relief, so elevation
    // goes in as meters × exaggeration. (An earlier WEB_MERCATOR_TO_WORLD_SCALE
    // factor made z ~78,000× too small → looked flat.)
    const lift = terrainEnabled ? exaggeration : 0;

    // Upstream builds an *adaptive* mesh whose density tracks reprojection
    // distortion — but for terrain there's none (3857→3857), so it collapses to
    // 4 corner vertices and can't represent relief. Build a dense REGULAR grid
    // instead and sample the DEM at every vertex. Pixel coords span 0..width
    // (the +1 edge) to keep neighboring COG tiles aligned, matching upstream.
    const N = TERRAIN_GRID;
    const dim = N + 1;
    const numVertices = dim * dim;
    const positions = new Float32Array(numVertices * 3);
    const texCoords = new Float32Array(numVertices * 2);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let missing = false;

    for (let j = 0; j < dim; j++) {
      const v = j / N;
      const py = v * height;
      for (let i = 0; i < dim; i++) {
        const u = i / N;
        const px = u * width;
        const idx = j * dim + i;
        const src = forwardTransform(px, py);
        const merc = forwardReproject(src[0], src[1]); // EPSG:3857 meters
        const x = merc[0];
        const y = merc[1];
        positions[idx * 3] = x;
        positions[idx * 3 + 1] = y;
        texCoords[idx * 2] = u;
        texCoords[idx * 2 + 1] = v;
        if (lift === 0) {
          positions[idx * 3 + 2] = 0;
          continue;
        }
        const [lng, lat] = mercatorToLngLat(x, y);
        if (!hasTileFor(lng, lat, demZoom)) missing = true;
        positions[idx * 3 + 2] = elevationAt(lng, lat, demZoom) * lift;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    // Two triangles per grid cell (CCW).
    const indices = new Uint32Array(N * N * 6);
    let t = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * dim + i;
        const b = a + 1;
        const c = a + dim;
        const d = c + 1;
        indices[t++] = a;
        indices[t++] = c;
        indices[t++] = b;
        indices[t++] = b;
        indices[t++] = c;
        indices[t++] = d;
      }
    }

    // Bump a mesh version so renderLayers can give the MeshTextureLayer a fresh
    // id → deck remounts the model and re-uploads geometry. SimpleMeshLayer's
    // `mesh` is an async prop, so a new mesh object on the same sublayer id does
    // NOT re-upload to the GPU; versioning the id is what actually updates it.
    this.setState({
      mesh: {
        indices: { value: indices, size: 1 },
        attributes: {
          POSITION: { value: positions, size: 3 },
          TEXCOORD_0: { value: texCoords, size: 2 },
        },
      },
      meshSig: this._sig(),
    });

    // DEM cache miss → warm the covering tiles (fire-and-forget). We deliberately
    // do NOT rebuild via a captured-`this` callback: `_renderSubLayers` mints a
    // fresh layer instance every render, so by the time tiles land THIS instance
    // is usually finalized and its rebuild would be a no-op. Instead, elevation.ts
    // notifies on each decoded tile → App bumps `demVersion` → normal deck
    // re-render → the LIVE layer's _generateMesh re-runs with a warm cache.
    if (lift !== 0 && missing) {
      prefetchTilesForBounds([minX, minY, maxX, maxY], demZoom);
    }
  }
}
