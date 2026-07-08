// Pure QC heuristics. They operate on already-decoded data so they are testable
// without an image library; a thin sharp-based adapter feeds these at runtime.

export const DEFAULT_QC = Object.freeze({
  darkThreshold: 128, // luminance below this counts as "ink"
  minInk: 0.005, // < 0.5% ink -> near-blank (failed conversion)
  maxInk: 0.6, // > 60% ink -> near-solid / too dark
});

/** Assess a coloring raster from its grayscale pixels (0-255 luminance).
 *  @param {ArrayLike<number>} grayPixels
 *  @returns {{ verdict: 'ok'|'flagged', reason: string, coverage?: number }} */
export function assessColoringPixels(grayPixels, opts = {}) {
  const { darkThreshold, minInk, maxInk } = { ...DEFAULT_QC, ...opts };
  const total = grayPixels.length;
  if (total === 0) return { verdict: 'flagged', reason: 'empty-image' };
  let ink = 0;
  for (let i = 0; i < total; i++) {
    if (grayPixels[i] < darkThreshold) ink++;
  }
  const coverage = ink / total;
  if (coverage < minInk) return { verdict: 'flagged', reason: 'near-blank', coverage };
  if (coverage > maxInk) return { verdict: 'flagged', reason: 'near-solid', coverage };
  return { verdict: 'ok', reason: 'ok', coverage };
}

/** A coloring SVG must be non-empty and contain actual drawing elements. */
export function assessColoringSvg(svg) {
  if (typeof svg !== 'string' || svg.trim() === '') {
    return { verdict: 'flagged', reason: 'empty-svg' };
  }
  const hasDrawing = /<(path|polyline|polygon|line|circle|ellipse|rect)\b/i.test(svg);
  if (!hasDrawing) return { verdict: 'flagged', reason: 'no-paths' };
  return { verdict: 'ok', reason: 'ok' };
}
