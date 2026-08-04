// Whiten the large solid-BLACK masses the generator sometimes bakes into a page — a dark hedge, a
// shadow, filled clothing — so the customer gets a colourable white area instead of an uncolourable
// black blob. This is the fix for "too much black": re-rolling and lightening the input do not touch
// it, because the darkness is in the source and the vectoriser fills it.
//
// Only BIG masses are removed. The signal is qc.js's own: split the raster into blocks, mark a block
// "solid" when it is ~all ink, and take connected runs of solid blocks. Thin OUTLINE strokes never
// fill a block, so they survive; small black fills (eyes, pupils, a nostril) form runs too tiny to
// pass the size gate, so they survive too. Exactly the masses assessSolidFill flags are the ones this
// clears — so a page that was flagged for solid-fill comes out clean.
//
// Both artefacts are cleaned from ONE raster-derived mask: the raster (_bw.png, what QC measures and
// the preview falls back to) has the masked blocks painted white; the SVG (what actually prints) has
// every black-FILL path whose points sit mostly inside the mask switched to fill="none". Black STROKES
// (the outlines) are never touched — only fills.

import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';

const DARK = 128; // a grayscale value below this is ink (matches qc.js darkThreshold)
const SOLID_RATIO = 0.9; // a block counts as solid when at least this fraction of it is ink
const BLOCKS_ACROSS = 128; // block edge = shortSide/128 — scale-invariant, same as qc.js
const MIN_BLOB_FRACTION = 0.0006; // clear a connected solid blob bigger than this fraction of the page

/** Block-grid mask (1 = this block belongs to a solid blob bigger than the size gate). Reuses the
 *  block + connected-component logic measureSolidFill uses, but keeps the member blocks so they can be
 *  painted out rather than just counted. */
function largeBlobMask(gray, W, H, { minBlobFraction = MIN_BLOB_FRACTION } = {}) {
  const blockPx = Math.max(4, Math.round(Math.min(W, H) / BLOCKS_ACROSS));
  const cols = Math.ceil(W / blockPx);
  const rows = Math.ceil(H / blockPx);
  const solid = new Uint8Array(cols * rows);
  for (let by = 0; by < rows; by++) {
    const y1 = Math.min((by + 1) * blockPx, H);
    for (let bx = 0; bx < cols; bx++) {
      const x1 = Math.min((bx + 1) * blockPx, W);
      let ink = 0, n = 0;
      for (let y = by * blockPx; y < y1; y++) {
        const row = y * W;
        for (let x = bx * blockPx; x < x1; x++, n++) if (gray[row + x] < DARK) ink++;
      }
      if (n > 0 && ink / n >= SOLID_RATIO) solid[by * cols + bx] = 1;
    }
  }

  const minBlocks = Math.max(2, Math.round(minBlobFraction * cols * rows));
  const seen = new Uint8Array(cols * rows);
  const stack = new Int32Array(cols * rows);
  const mask = new Uint8Array(cols * rows);
  for (let start = 0; start < solid.length; start++) {
    if (!solid[start] || seen[start]) continue;
    let top = 0, size = 0;
    const members = [];
    stack[top++] = start; seen[start] = 1;
    while (top > 0) {
      const p = stack[--top];
      size++; members.push(p);
      const x = p % cols, y = (p - x) / cols;
      if (x > 0 && solid[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x < cols - 1 && solid[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (y > 0 && solid[p - cols] && !seen[p - cols]) { seen[p - cols] = 1; stack[top++] = p - cols; }
      if (y < rows - 1 && solid[p + cols] && !seen[p + cols]) { seen[p + cols] = 1; stack[top++] = p + cols; }
    }
    if (size >= minBlocks) for (const p of members) mask[p] = 1;
  }
  // Dilate one block so a fill path traced along a blob's edge still reads as "inside".
  const dil = mask.slice();
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % cols, y = (i - x) / cols;
    if (x > 0) dil[i - 1] = 1;
    if (x < cols - 1) dil[i + 1] = 1;
    if (y > 0) dil[i - cols] = 1;
    if (y < rows - 1) dil[i + cols] = 1;
  }
  return { mask, dil, cols, rows, blockPx, blobBlocks: mask.reduce((a, b) => a + b, 0) };
}

/** Switch every black-FILL path whose coordinate points sit mostly inside the blob mask to fill="none".
 *  Strokes and small fills are left alone. Sampling the path's own points against the raster-derived
 *  mask is what maps the two representations without any fragile path-area maths. */
function deblobSvg(svgPath, dil, cols, rows, blockPx, rasterW, rasterH) {
  let svg = readFileSync(svgPath, 'utf8');
  const vm = svg.match(/viewBox\s*=\s*"([^"]+)"/i);
  if (!vm) return false;
  const [x0, y0, vw, vh] = vm[1].trim().split(/[\s,]+/).map(Number);
  if (![x0, y0, vw, vh].every(Number.isFinite) || vw <= 0 || vh <= 0) return false;
  const sx = rasterW / vw, sy = rasterH / vh; // svg units -> raster px
  const inMask = (ux, uy) => {
    const bx = Math.floor(((ux - x0) * sx) / blockPx);
    const by = Math.floor(((uy - y0) * sy) / blockPx);
    if (bx < 0 || bx >= cols || by < 0 || by >= rows) return false;
    return dil[by * cols + bx] === 1;
  };
  let changed = 0;
  svg = svg.replace(/<path\b[^>]*>/gi, (tag) => {
    if (!/fill\s*=\s*"#0{6}"/i.test(tag) && !/fill\s*=\s*"#000"/i.test(tag) && !/fill\s*=\s*"black"/i.test(tag)) return tag;
    const dm = tag.match(/\bd\s*=\s*"([^"]+)"/i);
    if (!dm) return tag;
    const nums = (dm[1].match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number).filter(Number.isFinite);
    let inN = 0, tot = 0;
    for (let i = 0; i + 1 < nums.length; i += 2) { tot++; if (inMask(nums[i], nums[i + 1])) inN++; }
    if (tot > 0 && inN / tot >= 0.5) { changed++; return tag.replace(/fill\s*=\s*"(#0{6}|#000|black)"/i, 'fill="none"'); }
    return tag;
  });
  if (changed) writeFileSync(svgPath, svg);
  return changed > 0;
}

/**
 * Clear the large black masses from a coloring page (raster + SVG). No-op when there are none.
 * @param {object} o
 * @param {string} o.pngPath  the _bw.png raster (rewritten in place)
 * @param {string} [o.svgPath] the coloring SVG (rewritten in place)
 * @param {number} [o.minBlobFraction]
 * @returns {Promise<{cleaned:boolean, blobBlocks?:number, reason?:string}>}
 */
export async function deblob({ pngPath, svgPath, minBlobFraction = MIN_BLOB_FRACTION } = {}) {
  const gr = await sharp(readFileSync(pngPath)).grayscale().raw().toBuffer({ resolveWithObject: true });
  const W = gr.info.width, H = gr.info.height;
  const { mask, dil, cols, rows, blockPx, blobBlocks } = largeBlobMask(gr.data, W, H, { minBlobFraction });
  if (!blobBlocks) return { cleaned: false, reason: 'no-large-blobs' };

  // Paint the raster white — but only the INK pixels inside the (dilated) blob mask, so the cut
  // follows the black mass's real shape instead of the block grid, and any stray light pixel in an
  // edge block is left alone. Dilated by a block so the blob's feathered edge is caught too.
  const gray = gr.data;
  const rw = await sharp(readFileSync(pngPath)).raw().toBuffer({ resolveWithObject: true });
  const { channels: ch } = rw.info;
  const px = rw.data;
  for (let y = 0; y < H; y++) {
    const by = (y / blockPx) | 0;
    for (let x = 0; x < W; x++) {
      if (!dil[by * cols + ((x / blockPx) | 0)]) continue;
      if (gray[y * W + x] >= DARK) continue; // only ink becomes white; paper stays paper
      const i = (y * W + x) * ch;
      for (let c = 0; c < Math.min(ch, 3); c++) px[i + c] = 255;
      if (ch === 4) px[i + 3] = 255;
    }
  }
  writeFileSync(pngPath, await sharp(px, { raw: { width: W, height: H, channels: ch } }).png().toBuffer());

  if (svgPath) deblobSvg(svgPath, dil, cols, rows, blockPx, W, H);
  return { cleaned: true, blobBlocks };
}

export { largeBlobMask };
