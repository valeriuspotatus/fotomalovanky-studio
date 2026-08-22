import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import sharp from 'sharp';
import { photoBase } from './organize.js';
import { assessResolution, assessBlur, assessExposure, dHash } from './inputQc.js';
import { imageExtension } from './shopify/safeFetch.js';

// Runtime adapter: decode one input photo and feed the pure heuristics in inputQc.js — the input
// mirror of qcFiles.js. The bytes are read once, hashed for exact-duplicate detection, then sharp
// decodes a small normalised grey copy for the blur / exposure / perceptual-hash measures.
// Resolution is judged on the true stored dimensions, not the normalised copy. The photo is
// EXIF-rotated first, exactly as the generator does before upload, so a portrait shot stored
// sideways is not mistaken for a different image than its corrected twin.

const NORM = 512; // short-side target: scale-normalises blur/exposure/hash and bounds cost
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_DIMENSION = 12_000;

/** Decode and assess one photo file.
 *  @returns {Promise<{ base:string, path:string, readable:boolean, sha1:?string,
 *    width:number, height:number, hash:Uint8Array,
 *    resolution:object, blur:object, exposure:object }>} */
export async function assessPhotoFile(photoPath, opts = {}) {
  const base = photoBase(photoPath);

  let bytes;
  try {
    const info = await stat(photoPath);
    if (!info.isFile() || info.size > MAX_BYTES) return unreadable(base, photoPath, null);
    bytes = await readFile(photoPath);
  } catch {
    return unreadable(base, photoPath, null);
  }
  const sha1 = createHash('sha1').update(bytes).digest('hex');
  if (/^\.hei[cf]$/i.test(extname(photoPath)) || imageExtension(bytes) === 'heic') return unreadable(base, photoPath, sha1);

  try {
    const img = sharp(bytes, { failOn: 'error', limitInputPixels: MAX_PIXELS, sequentialRead: true }).rotate();
    const meta = await img.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) return unreadable(base, photoPath, sha1);

    const { data, info } = await img
      .greyscale()
      .resize({ width: NORM, height: NORM, fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });

    return {
      base,
      path: photoPath,
      readable: true,
      sha1,
      width,
      height,
      hash: dHash(data, info.width, info.height),
      resolution: assessResolution(width, height, opts),
      blur: assessBlur(data, info.width, info.height, opts),
      exposure: assessExposure(data, opts),
    };
  } catch {
    // A file that reads as bytes but will not decode (truncated upload, an unsupported format) is
    // as un-generatable as a missing one — hold it, but keep the sha1 so a later re-upload of the
    // same broken bytes is still recognised as the same file.
    return unreadable(base, photoPath, sha1);
  }
}

function unreadable(base, path, sha1) {
  return {
    base,
    path,
    readable: false,
    sha1,
    width: 0,
    height: 0,
    hash: new Uint8Array(64),
    resolution: { verdict: 'hold', reason: 'unreadable', mp: 0, shortSide: 0 },
    blur: { verdict: 'ok', reason: 'ok', variance: 0 },
    exposure: { verdict: 'ok', reason: 'ok', mean: 0, clip: 0 },
  };
}
