/**
 * Persist the render-appearance knobs (colormap, reverse, range, darken,
 * brightness) to localStorage so a reload keeps the user's choices until they
 * change them. Scoped to color/look preferences only — not AOI, year, or mode,
 * which are navigational and better reset per visit.
 */
import {
  DEFAULT_NDVI_COLORMAP,
  DEFAULT_NDVI_RANGE,
  DEFAULT_NDVI_SCALE,
  INDEX_COLORMAPS,
  INDEX_KEYS,
  type NdviColormap,
  type RenderMode,
} from "./renderPipeline";

const KEY = "s2cog.colorPrefs.v1";
const DEFAULT_RGB_GAIN = 1.0;

export type ColorPrefs = {
  rgbGain: number;
  ndviColormap: NdviColormap;
  ndviRange: [number, number];
  ndviScale: number;
  ndviReversed: boolean;
  // RGB texture smoothing: true = linear magnification, false = nearest.
  smoothing: boolean;
  // Selected mosaic year. App validates against AVAILABLE_YEARS on load.
  year: number;
  // Render mode (rgb / a spectral index).
  mode: RenderMode;
  // Terrain knobs — saved so a crafted view comes back on reload.
  terrainEnabled: boolean;
  exaggeration: number; // "elevation scale" in the UI
  groundLevel: boolean;
};

export const DEFAULT_COLOR_PREFS: ColorPrefs = {
  rgbGain: DEFAULT_RGB_GAIN,
  ndviColormap: DEFAULT_NDVI_COLORMAP,
  ndviRange: DEFAULT_NDVI_RANGE,
  ndviScale: DEFAULT_NDVI_SCALE,
  ndviReversed: false,
  smoothing: false,
  year: 2023,
  mode: "rgb",
  terrainEnabled: true,
  exaggeration: 1,
  groundLevel: true,
};

const VALID_MODES: readonly string[] = ["rgb", ...INDEX_KEYS];

const num = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/**
 * Read + validate stored prefs. Anything missing, malformed, or stale (e.g. a
 * colormap name that no longer exists after we pruned the red-green ramps)
 * falls back to its default, so old/garbage storage can't break the UI.
 */
export function loadColorPrefs(): ColorPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_COLOR_PREFS;
    const p = JSON.parse(raw) as Partial<ColorPrefs>;
    const cmap =
      typeof p.ndviColormap === "string" &&
      (INDEX_COLORMAPS as readonly string[]).includes(p.ndviColormap)
        ? (p.ndviColormap as NdviColormap)
        : DEFAULT_NDVI_COLORMAP;
    const r = Array.isArray(p.ndviRange) ? p.ndviRange : DEFAULT_NDVI_RANGE;
    const mode =
      typeof p.mode === "string" && VALID_MODES.includes(p.mode)
        ? (p.mode as RenderMode)
        : "rgb";
    return {
      rgbGain: num(p.rgbGain, DEFAULT_RGB_GAIN),
      ndviColormap: cmap,
      ndviRange: [num(r[0], DEFAULT_NDVI_RANGE[0]), num(r[1], DEFAULT_NDVI_RANGE[1])],
      ndviScale: num(p.ndviScale, DEFAULT_NDVI_SCALE),
      ndviReversed: p.ndviReversed === true,
      smoothing: p.smoothing === true,
      year: num(p.year, 2023),
      mode,
      // Back-compat: older stored prefs lack these → fall to defaults (terrain on).
      terrainEnabled: p.terrainEnabled !== false,
      exaggeration: num(p.exaggeration, 1),
      groundLevel: p.groundLevel !== false,
    };
  } catch {
    return DEFAULT_COLOR_PREFS;
  }
}

export function saveColorPrefs(prefs: ColorPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / quota — preferences just won't persist */
  }
}

// ── Default camera view ─────────────────────────────────────────────────────
// A user-set "home" view (the SET DEFAULT button). When present it overrides the
// hardcoded initialViewState on load, so you land where you left it.
const VIEW_KEY = "s2cog.defaultView.v1";

export type SavedView = {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
};

export function loadDefaultView(): SavedView | null {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SavedView>;
    if (
      typeof v.longitude === "number" &&
      typeof v.latitude === "number" &&
      typeof v.zoom === "number"
    ) {
      return {
        longitude: v.longitude,
        latitude: v.latitude,
        zoom: v.zoom,
        pitch: num(v.pitch, 0),
        bearing: num(v.bearing, 0),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveDefaultView(v: SavedView): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

export function clearDefaultView(): void {
  try {
    localStorage.removeItem(VIEW_KEY);
  } catch {
    /* ignore */
  }
}
