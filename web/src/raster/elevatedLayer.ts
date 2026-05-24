import { ElevatedRasterLayer } from "./ElevatedRasterLayer";

// Mirrors @developmentseed/deck.gl-raster raster-tile-layer/constants.ts
// (not public exports).
const TILE_SIZE = 512;
const WEB_MERCATOR_TO_WORLD_SCALE = TILE_SIZE / 40075016.686;

/**
 * Wrap a `RasterTileLayer` subclass (COGLayer / MultiCOGLayer) so its per-tile
 * imagery mesh is elevated by the DEM.
 *
 * Both layers inherit `RasterTileLayer._renderSubLayers`, which hardcodes
 * `new RasterLayer(...)`. We override it with a faithful copy that builds an
 * `ElevatedRasterLayer` instead — still via `this.getSubLayerProps(...)` so
 * deck's CompositeLayer reconciliation/finalization works (a bare-`new` remap
 * broke mesh re-uploads after the first build). Geometry-only: the band
 * compositing / colormap pipeline (`renderTile` → image/renderPipeline) is
 * untouched, so RGB and spectral indices both keep rendering, just draped.
 */
export function makeElevatedTileLayer(Base: any, layerName: string): any {
  return class extends Base {
    static layerName = layerName;
    static defaultProps = {
      ...Base.defaultProps,
      exaggeration: { type: "number", value: 1.5 },
      demZoom: { type: "number", value: 13 },
      terrainEnabled: { type: "boolean", value: true },
      demVersion: { type: "number", value: 0 },
    };

    _renderSubLayers(props: any, descriptor: any, renderTile: any) {
      const { maxError, exaggeration, demZoom, terrainEnabled, demVersion } =
        this.props as any;
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
          exaggeration,
          demZoom,
          terrainEnabled,
          demVersion,
          ...deckProjectionProps,
        }) as any,
      );
      return [rasterLayer];
    }
  };
}
