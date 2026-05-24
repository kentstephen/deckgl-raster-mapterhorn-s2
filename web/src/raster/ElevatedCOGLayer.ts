import { COGLayer } from "@developmentseed/deck.gl-geotiff";
import { makeElevatedTileLayer } from "./elevatedLayer";

/** `COGLayer` (RGB / single-COG) draped on the DEM. See `elevatedLayer.ts`. */
export const ElevatedCOGLayer = makeElevatedTileLayer(
  COGLayer,
  "ElevatedCOGLayer",
);
