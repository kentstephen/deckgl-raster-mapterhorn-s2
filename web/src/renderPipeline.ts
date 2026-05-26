import type { RasterModule } from "@developmentseed/deck.gl-raster";
import {
  Colormap,
  COLORMAP_INDEX,
  LinearRescale,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import type { Texture } from "@luma.gl/core";
import { discardBlack, discardBoundlessPadding } from "./discardBlack";
import { NormalizedDifference } from "./shaders/ndvi";
import { ScaleColor } from "./shaders/scaleColor";
import { FalseColorStretch } from "./shaders/falseColor";

/** Sentinel-2 band assets we pull per item (RGB uses the precomposed TCI). */
export type BandKey = "B02" | "B03" | "B04" | "B08";

/**
 * Curated spectral-index registry (item 4). Every entry is a normalized
 * difference `(a - b) / (a + b)` so they all share one shader (`NormalizedDifference`)
 * and the existing MultiCOGLayer composite path — only the two band slots differ.
 * `a` is packed into color.r, `b` into color.g by the `composite` below.
 *
 * Only 10 m bands here (B03/B04/B08). NDBI/NDMI were dropped (2026-05-20): they
 * pair B11 (20 m SWIR) with a 10 m band, and the resolution/nodata-footprint
 * mismatch paints hard ±1 seams where one grid has data and the other pads with
 * zeros. See docs/SPECTRAL_INDICES.md. A non-normalized-difference index (EVI,
 * SAVI, BSI) would also need a dedicated shader + constants.
 */
export const INDICES = {
  ndvi: { label: "NDVI", a: "B08", b: "B04", desc: "vegetation" },
  ndwi: { label: "NDWI", a: "B03", b: "B08", desc: "water" },
  gndvi: { label: "GNDVI", a: "B08", b: "B03", desc: "green vegetation" },
  // Redness / iron-oxide: (red − blue)/(red + blue). Lights up red rock strata
  // (e.g. canyon sandstone), tracing geology + landform. Both 10 m → seam-free.
  redness: { label: "REDNESS", a: "B04", b: "B02", desc: "iron oxide / red rock" },
} as const satisfies Record<string, { label: string; a: BandKey; b: BandKey; desc: string }>;

export type IndexKey = keyof typeof INDICES;
export const INDEX_KEYS = Object.keys(INDICES) as IndexKey[];

/**
 * False-color band composites: raw bands stacked straight into R/G/B (no ratio,
 * no colormap). Unlike the normalized-difference indices these do NOT cancel
 * per-scene brightness offsets, so they show the Earth Genome mosaic's
 * acquisition seams — accepted tradeoff for true band-composite views.
 *
 * Only the CORS-open 10 m bands are available (B02/B03/B04/B08); no SWIR
 * (B11/B12 are 20 m + CORS-blocked), so the family is the NIR-driven composites.
 * `r/g/b` name the band fed to each output channel.
 */
export const FALSE_COLORS = {
  // Color-Infrared (CIR): NIR→red, red→green, green→blue. Vegetation glows red;
  // the classic Sentinel/Landsat 8-4-3 composite.
  cir: { label: "COLOR IR", r: "B08", g: "B04", b: "B03", desc: "vegetation (NIR)" },
  // NIR-G-B variant: NIR→red, green→green, blue→blue. Higher contrast on water
  // and bare soil than CIR.
  nirgb: { label: "NIR · G · B", r: "B08", g: "B03", b: "B02", desc: "NIR / water / soil" },
} as const satisfies Record<
  string,
  { label: string; r: BandKey; g: BandKey; b: BandKey; desc: string }
>;

export type FalseColorKey = keyof typeof FALSE_COLORS;
export const FALSE_COLOR_KEYS = Object.keys(FALSE_COLORS) as FalseColorKey[];

/**
 * "rgb" renders the precomposed TCI via COGLayer; index keys are GPU
 * normalized-difference ratios; false-color keys are raw 3-band stacks.
 */
export type RenderMode = "rgb" | IndexKey | FalseColorKey;

export function isFalseColorMode(mode: RenderMode): mode is FalseColorKey {
  return (FALSE_COLOR_KEYS as string[]).includes(mode);
}

export function isIndexMode(mode: RenderMode): mode is IndexKey {
  return mode !== "rgb" && !isFalseColorMode(mode);
}

/**
 * Colormaps exposed for index modes. Deuteranopia-friendly set: the red-green
 * ramps (rdylgn, spectral) were dropped because they're indistinguishable to
 * red-green colorblind viewers. cividis/viridis/plasma are perceptually uniform
 * and colorblind-safe; rdbu is a blue-red divergent (safe — the confusion axis
 * is red-green, not red-blue); emrld/earth/geyser are CARTOColors injected via
 * cartoColormaps.ts (not in the shipped sprite).
 */
export const INDEX_COLORMAPS = [
  "cividis",
  "viridis",
  "plasma",
  "rdbu",
  "emrld",
  "earth",
  "geyser",
  "sunset",
  "sunsetdark",
  "teal",
  "bluyl",
  "blues",
  "oranges",
] as const;
export type IndexColormap = (typeof INDEX_COLORMAPS)[number];
export const DEFAULT_NDVI_COLORMAP: IndexColormap = "cividis";

/** Default index stretch range — symmetric [-1, 1] centers divergent ramps at 0. */
export const DEFAULT_NDVI_RANGE: [number, number] = [-1, 1];

/** Default post-colormap multiplier; 1.0 = unchanged, <1 darkens. */
export const DEFAULT_NDVI_SCALE = 1.0;

/** Back-compat alias used by App's UI. */
export const NDVI_COLORMAPS = INDEX_COLORMAPS;
export type NdviColormap = IndexColormap;

/**
 * MultiCOGLayer `sources` slot → STAC asset map for an index mode. Slot names
 * (`a`, `b`) are packed into color channels by COMPOSITE below.
 */
export function bandSlotsFor(mode: IndexKey): Record<"a" | "b", BandKey> {
  const { a, b } = INDICES[mode];
  return { a, b };
}

/** Composite packing: index input `a`→color.r, `b`→color.g (uniform for all indices). */
export const INDEX_COMPOSITE = { r: "a", g: "b" } as const;

/**
 * MultiCOGLayer `sources` slot → STAC asset map for a false-color mode. Slots
 * are named by output channel (`r`/`g`/`b`); FALSE_COLOR_COMPOSITE maps each
 * straight through.
 */
export function falseColorBandSlots(
  mode: FalseColorKey,
): Record<"r" | "g" | "b", BandKey> {
  const { r, g, b } = FALSE_COLORS[mode];
  return { r, g, b };
}

/** Composite packing for false color: each named slot → its own output channel. */
export const FALSE_COLOR_COMPOSITE = { r: "r", g: "g", b: "b" } as const;

/**
 * Pipeline for a false-color band stack: cull padding/black, then a per-channel
 * reflectance stretch (the raw r16unorm bands are near-black without it). No
 * colormap — the bands ARE the color.
 */
export function buildFalseColorPipeline(opts: {
  blackPoint?: number;
  gain?: number;
}): RasterModule[] {
  return [
    { module: discardBlack },
    {
      module: FalseColorStretch,
      props: { blackPoint: opts.blackPoint ?? 0.0, gain: opts.gain ?? 8.0 },
    },
  ];
}

/** Default false-color stretch. Bands are r16unorm; reflectance fills a small
 *  slice of [0,1], so gain >> 1. Tunable in the panel. */
export const DEFAULT_FALSE_COLOR_GAIN = 8.0;
export const DEFAULT_FALSE_COLOR_BLACK = 0.0;

export function buildRenderPipeline(
  mode: RenderMode,
  colormapTexture: Texture | null,
  opts: {
    ndviColormap?: IndexColormap;
    // Resolved row index in the (possibly CARTO-augmented) colormap texture.
    // Falls back to the shipped sprite's COLORMAP_INDEX when omitted.
    colormapIndex?: number;
    ndviRange?: [number, number];
    ndviScale?: number;
    ndviReversed?: boolean;
  } = {},
): RasterModule[] {
  if (mode === "rgb") return []; // RGB is handled by COGLayer/renderTile, not here.
  if (!colormapTexture) return [];
  const [lo, hi] = opts.ndviRange ?? DEFAULT_NDVI_RANGE;
  return [
    { module: discardBoundlessPadding },
    { module: NormalizedDifference },
    { module: LinearRescale, props: { rescaleMin: lo, rescaleMax: hi } },
    {
      module: Colormap,
      props: {
        colormapTexture,
        colormapIndex:
          opts.colormapIndex ??
          COLORMAP_INDEX[(opts.ndviColormap ?? DEFAULT_NDVI_COLORMAP) as keyof typeof COLORMAP_INDEX],
        reversed: opts.ndviReversed ?? false,
      },
    },
    {
      module: ScaleColor,
      props: { factor: opts.ndviScale ?? DEFAULT_NDVI_SCALE },
    },
  ];
}
