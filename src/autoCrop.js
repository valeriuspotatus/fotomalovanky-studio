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

/** Crop a coloring page (PNG raster + SVG vector) to its ink. No-op when the drawing already fills
 *  the frame. Returns { cropped, kept } — `kept` is the fraction of area retained. */
export async function autoCropColoring({ pngPath, svgPath }) {
  const box = await contentBox(pngPath);
  if (!box) return { cropped: false, reason: 'blank' };
  const kept = (box.width * box.height) / (box.W * box.H);
  if (kept > SKIP_ABOVE) return { cropped: false, reason: 'already-full', kept };

  // sharp can't read and overwrite the same file in one pipeline — buffer, then write.
  const cropped = await sharp(pngPath).extract({ left: box.left, top: box.top, width: box.width, height: box.height }).png().toBuffer();
  writeFileSync(pngPath, cropped);
  if (svgPath) cropSvgViewBox(svgPath, box);
  return { cropped: true, kept, box };
}
