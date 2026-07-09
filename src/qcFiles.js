import { readFileSync, existsSync } from 'node:fs';
import sharp from 'sharp';
import { assessColoringPixels, assessColoringSvg } from './qc.js';

// Runtime adapter: decode one photo's organized outputs and feed the pure heuristics in
// qc.js. This is a degenerate-output tripwire — a blank page, a solid black page, an SVG
// with no paths — not a judge of drawing quality. The operator's review grid is that judge.

/** @param {{coloringPng?: string, coloringSvg: string}} out  paths from organize.outputPaths */
export async function assessOutputFiles(out, opts = {}) {
  if (!existsSync(out.coloringSvg)) return { verdict: 'flagged', reason: 'missing-svg' };
  const svg = assessColoringSvg(readFileSync(out.coloringSvg, 'utf8'));
  if (svg.verdict !== 'ok') return svg;

  if (!out.coloringPng || !existsSync(out.coloringPng)) return { verdict: 'flagged', reason: 'missing-png' };
  let gray;
  try {
    // flatten() first: a transparent pixel is white paper, not ink.
    gray = await sharp(out.coloringPng).flatten({ background: '#ffffff' }).greyscale().raw().toBuffer();
  } catch {
    return { verdict: 'flagged', reason: 'unreadable-image' };
  }
  return assessColoringPixels(gray, opts);
}
