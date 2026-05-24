import { COGLayer } from "@developmentseed/deck.gl-geotiff";
import { RasterLayer } from "@developmentseed/deck.gl-raster";
import { ElevatedRasterLayer } from "./ElevatedRasterLayer";

/**
 * `COGLayer` whose per-tile imagery mesh is elevated by the DEM.
 *
 * `RasterTileLayer._renderSubLayers` (inherited by COGLayer) hardcodes
 * `new RasterLayer(...)` with no class hook. Rather than copy that ~60-line
 * method, we let it run, then swap the produced `RasterLayer` for an
 * `ElevatedRasterLayer` built from the same props — reusing all of upstream's
 * reprojection / modelMatrix / coordinate-system setup.
 */
// COGLayer types `_renderSubLayers` as private, so subclassing through the
// typed class trips TS2415. Loosen to `any` (consistent with the rest of the
// layer wiring) — the runtime class is unchanged.
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
    const layers = super._renderSubLayers(props, descriptor, renderTile);
    const { exaggeration, demZoom, terrainEnabled, demVersion } = this.props as any;
    return (layers || []).map((l: any) =>
      l instanceof RasterLayer && !(l instanceof ElevatedRasterLayer)
        ? new ElevatedRasterLayer({
            ...l.props,
            exaggeration,
            demZoom,
            terrainEnabled,
            demVersion,
          } as any)
        : l,
    );
  }
}
