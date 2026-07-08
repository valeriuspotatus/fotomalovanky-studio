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
 *  The builder pairs "<base>.jpg" with "<base>_bw.svg"; the "_bw.png" is kept alongside.
 *  The original is normalized to ".jpg" so the pairing base is stable even for ".jpeg" inputs. */
export function outputNames(photoPath) {
  const base = photoBase(photoPath);
  return {
    base,
    original: `${base}.jpg`,
    coloringSvg: `${base}_bw.svg`,
    coloringPng: `${base}_bw.png`,
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
