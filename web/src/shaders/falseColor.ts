import type { ShaderModule } from "@luma.gl/shadertools";

const MODULE_NAME = "falseColorStretch";

/**
 * Reflectance stretch for false-color band composites. MultiCOGLayer's
 * auto-prepended CompositeBands module writes the three chosen bands into
 * color.r/g/b (see the `composite` map in renderPipeline.ts). The raw bands
 * arrive as r16unorm samples in [0,1] but real surface reflectance occupies a
 * small slice of that, so the image is near-black without a stretch.
 *
 * Per-channel linear stretch: `(value - blackPoint) * gain`, clamped to [0,1].
 * One shared blackPoint/gain across r/g/b (a true CIR keeps the band balance;
 * per-channel white-balance is a later refinement). Tune via the panel.
 */
export const FalseColorStretch = {
  name: MODULE_NAME,
  fs: `\
uniform ${MODULE_NAME}Uniforms {
  float blackPoint;
  float gain;
} ${MODULE_NAME};
`,
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      color.rgb = clamp(
        (color.rgb - vec3(${MODULE_NAME}.blackPoint)) * ${MODULE_NAME}.gain,
        0.0, 1.0
      );
    `,
  },
  uniformTypes: {
    blackPoint: "f32",
    gain: "f32",
  },
  getUniforms: (props: { blackPoint?: number; gain?: number }) => ({
    blackPoint: props.blackPoint ?? 0.0,
    gain: props.gain ?? 8.0,
  }),
} as const satisfies ShaderModule<{ blackPoint: number; gain: number }>;
