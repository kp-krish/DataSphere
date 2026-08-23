/**
 * Chart colour.
 *
 * These eight hues are not a taste decision - the ordering was chosen by
 * running a colour-vision validator over candidate orderings and keeping only
 * ones that clear every gate against this app's dark surface (#1a1a19).
 *
 * Measured for this order, dark mode:
 *
 *   adjacent pairs, all 8   worst CVD ΔE 8.6 (protan) · normal-vision ΔE 19.3
 *   all pairs, first 4      worst CVD ΔE 6.9            · normal-vision ΔE 19.3
 *   all pairs, first 3      worst CVD ΔE 13.2           · normal-vision ΔE 19.3
 *
 * (OKLab ×100. Target for adjacent pairs is ΔE ≥ 8; the normal-vision floor is
 * 15. Every slot also clears 3:1 contrast against the surface.)
 *
 * The distinction between "adjacent" and "all" pairs is what drives the two
 * rules below.
 *
 *   Bars, lines and stacks only ever put *neighbouring* slots side by side, so
 *   the adjacent gate is the one that applies and all eight are usable.
 *
 *   A pie compares every slice with every other, so the all-pairs gate applies.
 *   The first four clear it but land in the 6-8 band, which is legal only with
 *   secondary encoding - which is why PieWidget direct-labels every slice
 *   rather than relying on colour alone.
 *
 * The default palette order (blue, orange, aqua, yellow, …) was NOT usable
 * here: it puts yellow beside orange, and that pair measures normal-vision
 * ΔE 10.6 all-pairs - below the hard floor of 15, meaning readers with full
 * colour vision cannot reliably tell two adjacent pie slices apart.
 */

/** Fixed slot order. Never cycled, never generated past the end. */
export const SERIES_COLORS = [
  '#3987e5', // 1 blue
  '#c98500', // 2 yellow
  '#d55181', // 3 magenta
  '#008300', // 4 green
  '#e66767', // 5 red
  '#9085e9', // 6 violet
  '#d95926', // 7 orange
  '#199e70', // 8 aqua
] as const;

/**
 * Beyond eight slots, the tail folds into one neutral "Other" rather than
 * cycling back to slot 1. A ninth generated hue is indistinguishable from an
 * existing one under colour-vision deficiency, and reusing slot 1 tells the
 * reader two unrelated things are the same thing.
 */
export const OTHER_COLOR = '#898781';

export const MAX_SERIES = SERIES_COLORS.length;

/**
 * Colour for a series, by its stable position - not by its rank.
 *
 * Callers must pass the index the series holds in a *stable* ordering (the
 * order the query returned, or a sorted-once key list). Passing the index of a
 * freshly-sorted array would repaint every series whenever the data reordered,
 * and a reader who learned "Technology is blue" would be misled.
 */
export function seriesColor(index: number): string {
  return index < MAX_SERIES ? SERIES_COLORS[index]! : OTHER_COLOR;
}

/** Chart chrome. Mirrors the CSS custom properties in tokens.css. */
export const CHART_INK = {
  /** Chart surface - what the 2px gaps and rings are painted in. */
  surface: '#1a1a19',
  /** Axis labels and tick text. Recessive by design. */
  muted: '#898781',
  /** Hairline grid, one step off the surface. */
  grid: '#2c2c2a',
  /** Baseline / axis rule. */
  axis: '#383835',
  textPrimary: '#ffffff',
  textSecondary: '#c3c2b7',
} as const;

/** Area fills are a wash, never a saturated block. */
export const AREA_FILL_OPACITY = 0.1;

/**
 * The surface-coloured gap and ring that separate touching marks.
 *
 * Marks are separated by negative space, not by a stroke drawn around them: a
 * border adds ink that is not data.
 */
export const SURFACE_GAP_PX = 2;
