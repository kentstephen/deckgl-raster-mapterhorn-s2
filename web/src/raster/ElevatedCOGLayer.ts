import { COGLayer } from "@developmentseed/deck.gl-geotiff";
import { ElevatedRasterLayer } from "./ElevatedRasterLayer";

// Mirrors @developmentseed/deck.gl-raster raster-tile-layer/constants.ts
// (not public exports).
const TILE_SIZE = 512;
const WEB_MERCATOR_TO_WORLD_SCALE = TILE_SIZE / 40075016.686;

/**
 * `COGLayer` whose per-tile imagery mesh is elevated by the DEM.
 *
 * `RasterTileLayer._renderSubLayers` (inherited by COGLayer) hardcodes
 * `new RasterLayer(...)`. We override it with a faithful copy of that method,
 * changing only the layer class (→ `ElevatedRasterLayer`) and threading the
 * terrain props. Crucially the sublayer is still created via
 * `this.getSubLayerProps(...)` so deck's CompositeLayer reconciliation /
 * finalization works (an earlier `new ElevatedRasterLayer({...l.props})` remap
 * bypassed that and broke mesh re-uploads on every change after the first).
 */
export class ElevatedCOGLayer extends (COGLayer as any) {
  static layerName = "ElevatedCOGLayer";
  static defaultProps = {
    ...(COGLayer as any).defaultProps,
    exaggeration: { type: "number", value: 1.5 },
    demZoom: { type: "number", value: 13 },
    terrainEnabled: { type: "boolean", value: true },
    demVersion: { type: "number", value: 0 },
  };

  _renderSubLayers(props: any, descriptor: any, renderTile: any) {
    const { maxError } = this.props as any;
    const { exaggeration, demZoom, terrainEnabled, demVersion } = this.props as any;
    if (!props.data) return [];

    const tile = props.tile;
    const { forwardTransform, inverseTransform } = tile;
    const tileResult = renderTile(props.data);
    if (!tileResult) return [];
    const { image, renderPipeline } = tileResult;
    const { width, height } = props.data;

    const isGlobe = (this.context as any).viewport.resolution !== undefined;
    const reprojectionFns = isGlobe
      ? {
          forwardTransform,
          inverseTransform,
          forwardReproject: descriptor.projectTo4326,
          inverseReproject: descriptor.projectFrom4326,
        }
      : {
          forwardTransform,
          inverseTransform,
          forwardReproject: descriptor.projectTo3857,
          inverseReproject: descriptor.projectFrom3857,
        };
    const deckProjectionProps = isGlobe
      ? {}
      : {
          coordinateSystem: "cartesian",
          coordinateOrigin: [TILE_SIZE / 2, TILE_SIZE / 2, 0],
          modelMatrix: [
            WEB_MERCATOR_TO_WORLD_SCALE, 0, 0, 0,
            0, WEB_MERCATOR_TO_WORLD_SCALE, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
          ],
        };

    const rasterLayer = new ElevatedRasterLayer(
      this.getSubLayerProps({
        id: `${props.id}-raster`,
        width,
        height,
        ...(image !== undefined && { image }),
        renderPipeline,
        maxError,
        reprojectionFns,
        // terrain
        exaggeration,
        demZoom,
        terrainEnabled,
        demVersion,
        ...deckProjectionProps,
      }) as any,
    );
    return [rasterLayer];
  }
}
