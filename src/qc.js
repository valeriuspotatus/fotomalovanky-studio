// Pure QC heuristics. They operate on already-decoded data so they are testable
// without an image library; a thin sharp-based adapter feeds these at runtime.

export const DEFAULT_QC = Object.freeze({
  darkThreshold: 128, // luminance below this counts as "ink"
  minInk: 0.005, // < 0.5% ink -> near-blank (failed conversion)
  maxInk: 0.6, // > 60% ink -> near-solid / too dark

  // Solid-fill tripwire. Thresholds calibrated on order 1523 (16 rasters: the 8 the operator
  // shipped and the 8 this tool generated for the same photos). Worst shipped page scored
  // 0.122% solid / 0.025% blob; the two pages with filled hair and trousers scored 0.242% /
  // 0.111% and 3.946% / 2.399%. Both limits sit near the geometric midpoint of that gap.
  // Two positives is a thin basis — re-tune from the review grid's verdicts in state.json.
  solidRatio: 0.95, // a block counts as solid when >= 95% of its pixels are ink
  blocksAcrossShortSide: 128, // block edge = shortSide/128, so the measure is scale-invariant
  maxSolidBlob: 0.0005, // largest *connected* solid area, as a fraction of the page
  maxSolidFill: 0.01, // total solid area — backstop for fill scattered too thin to connect
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

/** Measure ink that forms *areas* rather than lines.
 *
 *  Ink coverage cannot see this: a page whose hair and trousers are filled solid black still
 *  covers only ~14% of the paper, nowhere near `maxInk`. So it passes the tripwire and prints,
 *  and the customer colours nothing on the parts that matter most.
 *
 *  The raster is split into blocks about 1/128 of its short side. A block is "solid" when nearly
 *  all of it is ink. Dense hatching — which the operator draws and ships — keeps white paper
 *  between its lines and so rarely fills a block; a filled hair mass fills many adjacent ones.
 *  Hence two numbers: the total solid area, and the largest *connected* solid area. The second is
 *  the sharper signal, because the defect is contiguous by nature and stray solid blocks (a pupil,
 *  a bold contour, a sunglasses lens) are isolated and small.
 *
 *  @param {ArrayLike<number>} grayPixels  row-major luminance, length width*height
 *  @returns {{ solidFill: number, solidBlob: number, blockPx: number, blocks: number }} fractions of the page */
export function measureSolidFill(grayPixels, width, height, opts = {}) {
  const { darkThreshold, solidRatio, blocksAcrossShortSide } = { ...DEFAULT_QC, ...opts };
  if (!(width > 0) || !(height > 0) || grayPixels.length < width * height) {
    return { solidFill: 0, solidBlob: 0, blockPx: 0, blocks: 0 };
  }

  const blockPx = Math.max(4, Math.round(Math.min(width, height) / blocksAcrossShortSide));
  const cols = Math.ceil(width / blockPx);
  const rows = Math.ceil(height / blockPx);
  const solid = new Uint8Array(cols * rows);
  let solidCount = 0;

  for (let by = 0; by < rows; by++) {
    const y1 = Math.min((by + 1) * blockPx, height);
    for (let bx = 0; bx < cols; bx++) {
      const x1 = Math.min((bx + 1) * blockPx, width);
      let ink = 0;
      let n = 0;
      for (let y = by * blockPx; y < y1; y++) {
        const row = y * width;
        for (let x = bx * blockPx; x < x1; x++, n++) {
          if (grayPixels[row + x] < darkThreshold) ink++;
        }
      }
      if (n > 0 && ink / n >= solidRatio) {
        solid[by * cols + bx] = 1;
        solidCount++;
      }
    }
  }

  // Largest connected run of solid blocks (4-neighbour flood fill, explicit stack).
  const seen = new Uint8Array(cols * rows);
  const stack = new Int32Array(cols * rows);
  let largest = 0;
  for (let start = 0; start < solid.length; start++) {
    if (!solid[start] || seen[start]) continue;
    let top = 0;
    let size = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const p = stack[--top];
      size++;
      const x = p % cols;
      const y = (p - x) / cols;
      if (x > 0 && solid[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x < cols - 1 && solid[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (y > 0 && solid[p - cols] && !seen[p - cols]) { seen[p - cols] = 1; stack[top++] = p - cols; }
      if (y < rows - 1 && solid[p + cols] && !seen[p + cols]) { seen[p + cols] = 1; stack[top++] = p + cols; }
    }
    if (size > largest) largest = size;
  }

  const blocks = cols * rows;
  return { solidFill: solidCount / blocks, solidBlob: largest / blocks, blockPx, blocks };
}

/** Flag a coloring raster whose ink forms filled regions instead of colourable outlines.
 *  @returns {{ verdict: 'ok'|'flagged', reason: string, solidFill: number, solidBlob: number }} */
export function assessSolidFill(grayPixels, width, height, opts = {}) {
  const { maxSolidBlob, maxSolidFill } = { ...DEFAULT_QC, ...opts };
  const { solidFill, solidBlob } = measureSolidFill(grayPixels, width, height, opts);
  const verdict = solidBlob > maxSolidBlob || solidFill > maxSolidFill ? 'flagged' : 'ok';
  return { verdict, reason: verdict === 'ok' ? 'ok' : 'solid-fill', solidFill, solidBlob };
}

const PAINT = /(?:stroke|fill)="([^"]*)"/gi;
const INVISIBLE = /^(?:none|#fff|#ffffff|white)$/i;

/** A coloring SVG must be non-empty, contain actual drawing elements, and actually draw something.
 *
 *  That last one is the whole reason this looks at colour. The tracer can return a page whose every
 *  stroke and fill is white: thousands of real paths, structurally perfect, and blank on paper.
 *  Nothing else catches it — `hasDrawing` sees the paths, and the raster checks below read the
 *  `_bw.png`, which is fine, because only the SVG came out wrong. Order 1563-5's fourth photo
 *  shipped exactly that: 6798 paths, every one #FFFFFF, a white box where the coloring page should
 *  be. A healthy page from this tracer always carries a dark layer (#000000, or #010101/#020202
 *  when it quantizes just off-black) alongside its white one. */
export function assessColoringSvg(svg) {
  if (typeof svg !== 'string' || svg.trim() === '') {
    return { verdict: 'flagged', reason: 'empty-svg' };
  }
  const hasDrawing = /<(path|polyline|polygon|line|circle|ellipse|rect)\b/i.test(svg);
  if (!hasDrawing) return { verdict: 'flagged', reason: 'no-paths' };

  // No paint attributes at all means every element takes SVG's default black fill — a drawing.
  // Only an SVG that paints, and paints nothing but white, is the failure this is looking for.
  const paints = [...svg.matchAll(PAINT)].map((m) => m[1].trim());
  if (paints.length && paints.every((p) => INVISIBLE.test(p))) {
    return { verdict: 'flagged', reason: 'blank-svg' };
  }
  return { verdict: 'ok', reason: 'ok' };
}
