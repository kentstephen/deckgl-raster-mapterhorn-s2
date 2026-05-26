import type { ShaderModule } from "@luma.gl/shadertools";

export const discardBlack = {
  name: "discard-black",
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      if (color.r + color.g + color.b < 0.01) {
        discard;
      }
    `,
  },
} as const satisfies ShaderModule;

/**
 * Discards pixels where EITHER index input band is the MultiCOGLayer
 * `boundless: true` zero-padding outside a COG's data area.
 *
 * A normalized-difference index `(a − b)/(a + b)` needs BOTH bands. Where only
 * one is present — e.g. B08 (10 m) vs B11 (20 m, SWIR) have different
 * footprints/edges, so one COG pads with zeros while the other still has data —
 * the ratio collapses to a constant ±1 and paints a hard yellow/blue seam.
 * Requiring both bands present drops those one-sided edges.
 *
 * Runs first in the index pipeline (color.r = band a, color.g = band b;
 * color.b is always 0 by composite, so it is excluded from the test).
 * Threshold is ~2 × the smallest r16unorm step, so real low-reflectance pixels
 * (deep water, shadow) survive.
 */
export const discardBoundlessPadding = {
  name: "discard-boundless-padding",
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      if (color.r < 0.00005 || color.g < 0.00005) {
        discard;
      }
    `,
  },
} as const satisfies ShaderModule;

/**
 * Discards a pixel if ANY of the three composited bands is the MultiCOGLayer
 * zero-padding (~0). For false-color band stacks (R/G/B = three separate band
 * COGs): while a tile's bands stream in, a not-yet-loaded band reads 0. With a
 * sum-based discard (discardBlack) such a half-loaded tile renders dark/black
 * and deck caches that frame, so it stays black until a viewport change forces a
 * re-render. Requiring all three bands present instead drops the tile to
 * transparent (terrain shows through) until it's complete — same behavior as the
 * index path's discardBoundlessPadding, which is why indices never show this.
 * Threshold is ~machine-zero, so real low-reflectance pixels survive.
 */
export const discardIncompleteBands = {
  name: "discard-incomplete-bands",
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      if (color.r < 0.00005 || color.g < 0.00005 || color.b < 0.00005) {
        discard;
      }
    `,
  },
} as const satisfies ShaderModule;
