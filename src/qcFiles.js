import { readFileSync, existsSync } from 'node:fs';
import sharp from 'sharp';
import { assessColoringPixels, assessColoringSvg, assessSolidFill } from './qc.js';

// Runtime adapter: decode one photo's organized outputs and feed the pure heuristics in
// qc.js. This is a tripwire for output that is wrong on its face — a blank page, a solid black
// page, an SVG with no paths, a drawing whose dark areas are filled in rather than outlined —
// not a judge of drawing quality. It cannot see an invented background or a lost likeness.
// The operator's review grid is that judge.

/** @param {{coloringPng?: string, coloringSvg: string}} out  paths from organize.outputPaths */
export async function assessOutputFiles(out, opts = {}) {
  if (!existsSync(out.coloringSvg)) return { verdict: 'flagged', reason: 'missing-svg' };
  const svg = assessColoringSvg(readFileSync(out.coloringSvg, 'utf8'));
  if (svg.verdict !== 'ok') return svg;

  if (!out.coloringPng || !existsSync(out.coloringPng)) return { verdict: 'flagged', reason: 'missing-png' };
  let gray, width, height;
  try {
    // flatten() first: a transparent pixel is white paper, not ink.
    const decoded = await sharp(out.coloringPng)
      .flatten({ background: '#ffffff' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    gray = decoded.data;
    ({ width, height } = decoded.info);
  } catch {
    return { verdict: 'flagged', reason: 'unreadable-image' };
  }

  // Degenerate output first — a blank or black page makes the solid-fill measure meaningless.
  const ink = assessColoringPixels(gray, opts);
  if (ink.verdict !== 'ok') return ink;

  const fill = assessSolidFill(gray, width, height, opts);
  return { ...fill, coverage: ink.coverage };
}
