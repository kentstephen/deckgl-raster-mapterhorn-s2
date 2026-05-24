/**
 * THROWAWAY SPIKE (Stage 0 of docs/plan): does deck.gl's TerrainExtension drape
 * the deck.gl-raster imagery pipeline onto a TerrainLayer surface?
 *
 * If GREEN (the S2 RGB tiles follow the terrain relief under pitch), we adopt
 * deck TerrainLayer + TerrainExtension and delete the hand-rolled elevation.ts /
 * ElevatedRasterLayer stack. If RED, we fall back to hardening Path B.
 *
 * Reached via `?spike=terrain` (see main.tsx). Tests INTERLEAVED first (current
 * architecture, best case). Uses the stock COGLayer (NOT Elevated*) + a stock
 * TerrainLayer; the only new ingredient is the extension.
 */
import { useEffect, useRef, useState } from "react";
import {
  Map as MaplibreMap,
  useControl,
  type MapRef,
} from "react-map-gl/maplibre";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { TerrainLayer } from "@deck.gl/geo-layers";
import { _TerrainExtension as TerrainExtension } from "@deck.gl/extensions";
import { COGLayer } from "@developmentseed/deck.gl-geotiff";
import { epsgResolver } from "@developmentseed/proj";
import "maplibre-gl/dist/maplibre-gl.css";

import { fetchStacItems, type PartialSTACItem } from "../stac";
import { loadGeoTIFF } from "../loadGeotiff";
import { getTileData } from "../getTileData";
import { renderTile } from "../renderTile";

// Grand Teton — same bbox/view as App, big relief for an obvious result.
const STAC_BBOX: [number, number, number, number] = [-111.0, 43.5, -110.5, 44.0];

// Mapterhorn terrarium tiles. TerrainLayer decodes terrarium on workers.
const TERRAIN_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
const TERRARIUM_DECODER = {
  rScaler: 256,
  gScaler: 1,
  bScaler: 1 / 256,
  offset: -32768,
};

function Overlay({ layers }: { layers: any[] }) {
  const overlay = useControl(
    () => new MapboxOverlay({ interleaved: true, layers } as any),
  );
  overlay.setProps({ layers });
  return null;
}

export default function TerrainSpike() {
  const mapRef = useRef<MapRef>(null);
  const [layers, setLayers] = useState<any[]>([]);
  const [status, setStatus] = useState("fetching STAC…");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { items } = await fetchStacItems({
          datetime: "2023-01-01T00:00:00Z/2023-12-31T23:59:59Z",
          bbox: STAC_BBOX,
        });
        if (cancelled) return;
        if (items.length === 0) {
          setStatus("no STAC items");
          return;
        }
        setStatus(`opening ${items.length} COG(s)…`);
        // Open every item's TCI so the whole view fills (mirrors App, minus the
        // MosaicLayer wrapper — one COGLayer per item is enough for the spike).
        const opened = await Promise.all(
          items.map(async (it: PartialSTACItem) => ({
            it,
            geotiff: await loadGeoTIFF(it.assets.visual.href).catch(() => null),
          })),
        );
        if (cancelled) return;

        const terrain = new TerrainLayer({
          id: "spike-terrain",
          elevationData: TERRAIN_URL,
          elevationDecoder: TERRARIUM_DECODER,
          // 'terrain+draw': acts as the terrain surface AND draws (so we see the
          // hillside even where no COG covers). Draped layers render on top.
          operation: "terrain+draw" as any,
          meshMaxError: 4,
          color: [40, 44, 48],
          maxZoom: 17,
        });

        const cogLayers = opened
          .filter((o) => o.geotiff)
          .map(
            (o) =>
              new COGLayer({
                id: `spike-cog-${o.it.id}`,
                geotiff: o.geotiff,
                epsgResolver,
                getTileData: (image: any, opts: any) =>
                  getTileData(image, opts, "nearest"),
                renderTile: (tileData: any) => renderTile(tileData, 1.0),
                refinementStrategy: "best-available",
                maxRequests: 16,
                // THE TEST: drape this layer onto the TerrainLayer surface.
                extensions: [new TerrainExtension()],
              } as any),
          );

        setLayers([terrain, ...cogLayers]);
        setStatus(`draping ${cogLayers.length} COG layer(s) on terrain`);
      } catch (e) {
        setStatus(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <MaplibreMap
        ref={mapRef}
        initialViewState={{
          longitude: -110.8024,
          latitude: 43.7412,
          zoom: 12,
          pitch: 60,
          bearing: 30,
        }}
        maxPitch={75}
        attributionControl={false}
        mapStyle="https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json"
      >
        <Overlay layers={layers} />
      </MaplibreMap>
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          padding: "6px 10px",
          background: "rgba(0,0,0,0.7)",
          color: "#7dd3c0",
          font: "12px ui-monospace, monospace",
          borderRadius: 6,
          zIndex: 10,
        }}
      >
        SPIKE: TerrainExtension drape — {status}
      </div>
    </div>
  );
}
