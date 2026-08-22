import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const PHOTO_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;

/** Windows refuses to overwrite a file another handle still holds. The review grid reads these
 *  very files to draw its tiles while the run rewrites them, and a virus scanner or an open
 *  Explorer preview can hold one too. The lock is momentary, so wait it out rather than failing
 *  a photo the GPU already paid for. (`UNKNOWN` is libuv's word for a Windows error it has no
 *  errno for — a memory-mapped read is one.) */
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES', 'UNKNOWN']);
const COPY_ATTEMPTS = 6;
const COPY_BACKOFF_MS = 60;

export async function copyWithRetry(src, dest, { attempts = COPY_ATTEMPTS, backoffMs = COPY_BACKOFF_MS, copy = copyFileSync, sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return copy(src, dest);
    } catch (err) {
      if (attempt >= attempts || !LOCKED.has(err?.code)) throw err;
      await wait(backoffMs * attempt);
    }
  }
}

/** True for advertised or explicitly-held input formats (case-insensitive). */
export function isPhoto(filename) {
  return PHOTO_EXT.test(filename) && !/_bw\.png$/i.test(filename);
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
export async function writeOutputs(photoPath, orderDir, result) {
  mkdirSync(orderDir, { recursive: true });
  const out = outputPaths(photoPath, orderDir);
  await copyWithRetry(result.originalPath, out.original);
  await copyWithRetry(result.coloringSvgPath, out.coloringSvg);
  if (result.coloringPngPath) await copyWithRetry(result.coloringPngPath, out.coloringPng);
  return out;
}
