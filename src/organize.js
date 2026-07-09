import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const PHOTO_EXT = /\.(jpe?g)$/i;

/** True for .jpg / .jpeg input photos (case-insensitive). */
export function isPhoto(filename) {
  return PHOTO_EXT.test(filename);
}

/** Base name without directory or extension: "abc.jpg" -> "abc". */
export function photoBase(photoPath) {
  return basename(photoPath, extname(photoPath));
}

/** Builder-compatible output names for one input photo.
 *  Mirrors the generator's own download bundle (confirmed from coloring-book-<job>.zip):
 *  each photo yields "<base>.jpg" (original), "<base>_bw.png" (raster line-art), and
 *  "<base>.svg" (vector line-art). Note the "_bw" suffix is on the PNG, not the SVG.
 *  The original is normalized to ".jpg" so the pairing base is stable even for ".jpeg" inputs. */
export function outputNames(photoPath) {
  const base = photoBase(photoPath);
  return {
    base,
    original: `${base}.jpg`,
    coloringPng: `${base}_bw.png`,
    coloringSvg: `${base}.svg`,
  };
}

/** Same as outputNames but joined into an order directory. */
export function outputPaths(photoPath, orderDir) {
  const names = outputNames(photoPath);
  return {
    base: names.base,
    original: join(orderDir, names.original),
    coloringSvg: join(orderDir, names.coloringSvg),
    coloringPng: join(orderDir, names.coloringPng),
  };
}

/** The only side-effecting function here: copy a generator result into the order folder
 *  under the builder's expected names. Returns the written paths. */
export function writeOutputs(photoPath, orderDir, result) {
  mkdirSync(orderDir, { recursive: true });
  const out = outputPaths(photoPath, orderDir);
  copyFileSync(result.originalPath, out.original);
  copyFileSync(result.coloringSvgPath, out.coloringSvg);
  if (result.coloringPngPath) copyFileSync(result.coloringPngPath, out.coloringPng);
  return out;
}
