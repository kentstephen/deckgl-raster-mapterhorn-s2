import { MultiCOGLayer } from "@developmentseed/deck.gl-geotiff";
import { makeElevatedTileLayer } from "./elevatedLayer";

/** `MultiCOGLayer` (spectral indices: NDVI/NDWI/…) draped on the DEM. */
export const ElevatedMultiCOGLayer = makeElevatedTileLayer(
  MultiCOGLayer,
  "ElevatedMultiCOGLayer",
);
