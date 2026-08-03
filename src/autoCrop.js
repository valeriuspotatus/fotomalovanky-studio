// Auto-crop the generator's coloring page down to its actual drawing. The image model returns each
// page on its own canvas, and when it drops the background (a boat on water becomes a boat on white)
// the subject ends up marooned in a wide white margin — which then prints as ugly white borders and
// wastes the page. This trims the page to the ink and rewrites the SVG's viewBox to match, so the
// drawing fills the printable area. A page whose ink already reaches the edges is left untouched.
//
// The raster (_bw.png) is the source of truth for where the ink is (measuring an SVG needs a render);
// the SVG is what actually prints, so both are cropped to the same box, in the SVG's own units.

import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';

const INK = 120; // a grayscale value below this is a drawn line, not paper
const NOISE_FRACTION = 0.003; // a row/column needs this fraction of ink pixels to count as content (ignores stray specks)
const MARGIN_FRACTION = 0.012; // breathing room left around the drawing so lines aren't flush to the cut
const SKIP_ABOVE = 0.94; // when the ink already fills >94% of the frame, there's nothing to gain — leave it

const FRAME_BAND = 0.05; // only look this far in from each edge for a border keyline
const FRAME_INK_FRACTION = 0.85; // a perimeter row/col this solid across its whole span is a frame, not content

/** Remove a solid black keyline the model sometimes draws around a page (mostly on wide/landscape
 *  outputs) — it would otherwise print as an ugly black border, and it defeats autoCrop because the
 *  frame IS the outermost ink (so the ink box is the whole page). We scan each edge's outer band for a
 *  near-100%-ink line and crop the page (PNG + SVG viewBox together) to just inside it. Content lines
 *  are never fully solid edge-to-edge, so the 0.85 threshold leaves real drawing alone; edges with no
 *  border keep their edge. Returns { deframed } — false when no border line is found (the common case),
 *  so it's safe to run on every page before autoCrop. */
export async function deframe({ pngPath, svgPath } = {}) {
  const { data, info } = await sharp(pngPath).grayscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const rowFrac = (y) => { let c = 0; const o = y * W; for (let x = 0; x < W; x++) if (data[o + x] < INK) c++; return c / W; };
  const colFrac = (x) => { let c = 0; for (let y = 0; y < H; y++) if (data[y * W + x] < INK) c++; return c / H; };
  const bandY = Math.max(1, Math.round(H * FRAME_BAND));
  const bandX = Math.max(1, Math.round(W * FRAME_BAND));
  // The innermost frame line inside each edge band (or -1). Innermost so a doubled border is fully cleared.
  let top = -1; for (let y = 0; y < bandY; y++) if (rowFrac(y) >= FRAME_INK_FRACTION) top = y;
  let bottom = -1; for (let y = H - 1; y >= H - bandY; y--) if (rowFrac(y) >= FRAME_INK_FRACTION) bottom = y;
  let left = -1; for (let x = 0; x < bandX; x++) if (colFrac(x) >= FRAME_INK_FRACTION) left = x;
  let right = -1; for (let x = W - 1; x >= W - bandX; x--) if (colFrac(x) >= FRAME_INK_FRACTION) right = x;
  // Only treat it as a border when it's actually frame-shaped: a full rectangle (≥3 edges) or a
  // letterbox (an opposite pair). A single solid edge line — a wall, a table edge flush to the border —
  // is real drawing, not a frame, and must be left alone.
  const found = [top >= 0, bottom >= 0, left >= 0, right >= 0].filter(Boolean).length;
  const pairH = top >= 0 && bottom >= 0;
  const pairV = left >= 0 && right >= 0;
  if (found < 3 && !pairH && !pairV) return { deframed: false };
  const l = left >= 0 ? left + 1 : 0;
  const t = top >= 0 ? top + 1 : 0;
  const r = right >= 0 ? right - 1 : W - 1;
  const b = bottom >= 0 ? bottom - 1 : H - 1;
  // A frame should only ever be a thin border; if "inside the frame" is less than half the page, the
  // detection is wrong (e.g. a genuinely ink-heavy page) — leave it alone rather than gut the drawing.
  if (r - l < W * 0.5 || b - t < H * 0.5) return { deframed: false };
  const box = { W, H, left: l, top: t, width: r - l + 1, height: b - t + 1 };
  await cropTo({ pngPath, svgPath, box });
  return { deframed: true, box };
}

/** The tight bounding box of the ink in a coloring page, plus a small margin. Null for a blank page
 *  (all paper) — cropping that to nothing would be worse than leaving it. Returns box in PNG pixels. */
export async function contentBox(pngPath) {
  const { data, info } = await sharp(pngPath).grayscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const minRow = Math.max(2, Math.round(W * NOISE_FRACTION));
  const minCol = Math.max(2, Math.round(H * NOISE_FRACTION));
  const rowInk = (y) => { let c = 0; const o = y * W; for (let x = 0; x < W; x++) if (data[o + x] < INK) c++; return c; };
  const colInk = (x) => { let c = 0; for (let y = 0; y < H; y++) if (data[y * W + x] < INK) c++; return c; };

  let top = 0; while (top < H && rowInk(top) < minRow) top++;
  if (top === H) return null; // no ink anywhere
  let bottom = H - 1; while (bottom > top && rowInk(bottom) < minRow) bottom--;
  let left = 0; while (left < W && colInk(left) < minCol) left++;
  let right = W - 1; while (right > left && colInk(right) < minCol) right--;

  const mx = Math.round(W * MARGIN_FRACTION), my = Math.round(H * MARGIN_FRACTION);
  left = Math.max(0, left - mx); top = Math.max(0, top - my);
  right = Math.min(W - 1, right + mx); bottom = Math.min(H - 1, bottom + my);
  return { W, H, left, top, width: right - left + 1, height: bottom - top + 1 };
}

/** Rewrite an SVG's viewBox to the crop box (given in PNG pixels), scaled into the SVG's own units.
 *  The generator writes a viewBox and no width/height, so the viewBox alone frames the page. */
function cropSvgViewBox(svgPath, box) {
  const svg = readFileSync(svgPath, 'utf8');
  const m = svg.match(/viewBox\s*=\s*"([^"]+)"/i);
  if (!m) return false;
  const [x0, y0, vw, vh] = m[1].trim().split(/[\s,]+/).map(Number);
  if (![x0, y0, vw, vh].every(Number.isFinite) || vw <= 0 || vh <= 0) return false;
  const sx = vw / box.W, sy = vh / box.H; // usually 1:1, but the SVG may be at a different scale
  const nx = (x0 + box.left * sx).toFixed(2);
  const ny = (y0 + box.top * sy).toFixed(2);
  const nw = (box.width * sx).toFixed(2);
  const nh = (box.height * sy).toFixed(2);
  writeFileSync(svgPath, svg.replace(m[0], `viewBox="${nx} ${ny} ${nw} ${nh}"`));
  return true;
}

/** Extract a box (in PNG pixels) from the raster and crop the SVG viewBox to match, so the printed
 *  vector and the raster stay in sync. Shared by autoCrop and deframe. */
async function cropTo({ pngPath, svgPath, box }) {
  // sharp can't read and overwrite the same file in one pipeline — buffer, then write.
  const cropped = await sharp(pngPath).extract({ left: box.left, top: box.top, width: box.width, height: box.height }).png().toBuffer();
  writeFileSync(pngPath, cropped);
  if (svgPath) cropSvgViewBox(svgPath, box);
}

/** Crop a coloring page (PNG raster + SVG vector) to its ink. No-op when the drawing already fills
 *  the frame. Returns { cropped, kept } — `kept` is the fraction of area retained. */
export async function autoCropColoring({ pngPath, svgPath }) {
  const box = await contentBox(pngPath);
  if (!box) return { cropped: false, reason: 'blank' };
  const kept = (box.width * box.height) / (box.W * box.H);
  if (kept > SKIP_ABOVE) return { cropped: false, reason: 'already-full', kept };
  await cropTo({ pngPath, svgPath, box });
  return { cropped: true, kept, box };
}

/**
 * The whole tidy-up a finished coloring page gets: whiten the model's border keyline, then trim the
 * page to its ink.
 *
 * ONE FUNCTION BECAUSE THERE IS MORE THAN ONE WAY TO PRODUCE A PAGE. This ran inline in batch.js and
 * therefore only on pages the generator made through the studio. A page repaired in the generator's
 * own web UI and dropped into the order folder ("Repair elsewhere…" → "I've replaced it") reached
 * the book untouched — frame, white margin and all — which is exactly what the operator kept seeing
 * after the pipeline had been fixed. Every path that puts a page on disk calls this now.
 *
 * Never throws: a page the GPU already paid for is perfectly usable uncropped, and a crop hiccup is
 * not a reason to fail it. The caller is told what happened so it can log it.
 *
 * @returns {Promise<{deframed:boolean, cropped:boolean, kept:?number, error:?string}>}
 */
export async function tidyColoringPage({ pngPath, svgPath } = {}) {
  try {
    const df = await deframe({ pngPath, svgPath });
    const c = await autoCropColoring({ pngPath, svgPath });
    return { deframed: Boolean(df.deframed), cropped: Boolean(c.cropped), kept: c.cropped ? c.kept : null, error: null };
  } catch (err) {
    return { deframed: false, cropped: false, kept: null, error: err.message };
  }
}
