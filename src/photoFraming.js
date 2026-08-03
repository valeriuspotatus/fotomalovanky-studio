// What a photo needs before it is drawn: which way is up, and — when the customer sent a screenshot
// rather than a photo — where the actual picture lives inside it.
//
// WHY THIS CANNOT BE DONE FROM EXIF.
//
// `prepareImageForUpload` already bakes in the camera's EXIF orientation flag, and inputQcFiles and
// the dashboard's thumbnails do the same. That covers the phone-held-sideways case and nothing else:
// across the live archive only 18 of 248 photos carry an orientation flag at all. The rest are
// stored with the pixels already rotated and no metadata admitting it — a customer's crop, a
// re-save, a messaging app, a CDN that stripped the block. For those, "which way is up" is a fact
// about the CONTENT, and only something that can see the picture can answer it.
//
// A screenshot is the same kind of fact. A phone screenshot of a school gallery arrives as a real
// JPEG of the right shape; nothing in the file says the top fifth is a status bar and the bottom is
// a navigation bar. Printed as-is it becomes a colouring page of somebody's battery icon.
//
// WHAT THIS COSTS AND WHY IT IS SHAPED THIS WAY.
//
// One `gemini-flash-lite-latest` call per photo, on a 512px copy — the light model on a small image,
// because "which way up" and "roughly where is the picture" need no more resolution than that, and
// the customer's original is never what gets sent to the network in full.
//
// EVERY failure answers NO_CORRECTION rather than throwing. A photo that cannot be analysed is a
// photo that gets drawn exactly as it would have been before this module existed; it is never a
// photo that fails. The analysis is an improvement on the pipeline, never a new way for it to break.

import sharp from 'sharp';
import { describeImage } from './creatives/aiImage.js';

/** Short side sent to the model. Orientation and a coarse box need no more, and it bounds the cost. */
const ANALYSIS_PX = 512;

/** A crop must keep at least this fraction of each axis. A model that answers with a sliver has
 *  misread the picture, and cropping a child's face down to nothing is far worse than not cropping. */
const MIN_CROP_FRACTION = 0.15;

/** A screenshot whose content box is nearly the whole frame is not worth cropping — the chrome it
 *  would remove is a few pixels, and every crop is a re-encode. */
const SKIP_CROP_ABOVE = 0.97;

/** The answer when nothing should change. Frozen and shared: callers compare against it freely. */
export const NO_CORRECTION = Object.freeze({ rotate: 0, screenshot: false, crop: null });

/** Which edge the top of the scene points to -> the clockwise turn that puts it back on top.
 *
 *  The model is asked WHERE THE TOP IS, not what angle to turn. Measured on both phrasings across
 *  every orientation of two real order photos: asking for an angle was right 6 times out of 8 and
 *  wrong in the same place each time — a photo stored turned 270° came back "270", which is 180° out
 *  and prints the child upside down. Asking which edge the heads point to was right 8 times out of 8.
 *  "Where is the sky?" is a thing you can see; "how many degrees clockwise?" is arithmetic done after
 *  seeing, and that is the step that slipped. */
const TURN_FOR_UP = Object.freeze({ top: 0, left: 90, bottom: 180, right: 270 });

export const FRAMING_INSTRUCTION = [
  'You are preparing a customer photograph for printing as a line-art colouring page.',
  'Answer with a single JSON object and nothing else. No prose, no code fence.',
  '',
  'Fields:',
  '  "up"         — one of "top", "right", "bottom", "left". The edge of the image that the TOP OF',
  '                 THE SCENE currently points to: the sky, the ceiling, the tops of people\'s heads.',
  '                   "top"    already the right way up, heads near the top edge',
  '                   "left"   heads point to the left edge',
  '                   "right"  heads point to the right edge',
  '                   "bottom" upside down, heads near the bottom edge',
  '  "screenshot" — true only if this is a capture of a phone or computer SCREEN: a status bar, a',
  '                 browser address bar, app navigation, a share sheet, chat bubbles, letterboxing',
  '                 around a picture. A plain photograph, however it was taken, is false.',
  '  "crop"       — null when "screenshot" is false. When true, the rectangle of the ACTUAL',
  '                 photograph inside the screen capture, as fractions of width and height:',
  '                 {"x":0.0,"y":0.12,"w":1.0,"h":0.7}. Give the coordinates for the image AS YOU',
  '                 SEE IT, before any rotation you asked for.',
  '',
  '                 Be TIGHT. The rectangle must contain only the photograph\'s own pixels and stop',
  '                 exactly at its edges. Everything the screen drew around it is excluded:',
  '                   - status bars, address bars, tabs, navigation bars',
  '                   - a white or coloured card, border, frame or rounded corner the photo sits on',
  '                   - captions and page counters such as "12 of 55"',
  '                   - arrows, close buttons, hearts, share and comment icons',
  '                   - black or grey letterbox bands',
  '                 If the photograph sits inside a gallery or viewer, give the edges of the',
  '                 PHOTOGRAPH, not the edges of the viewer or the card holding it.',
  '',
  'If you are unsure which way is up, answer "top". If unsure whether it is a screen capture, answer false.',
].join('\n');

/** Pull the first JSON object out of a model reply, tolerating a ```json fence or a stray sentence.
 *  Returns null rather than throwing — an unparseable answer is simply no answer. */
function parseJsonObject(text) {
  if (typeof text !== 'string') return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Coerce a raw model answer into a correction this pipeline will act on, or NO_CORRECTION.
 *
 *  Exported and pure so the whole decision table is testable without a network: every rejection
 *  below is a way a plausible-looking reply could ruin a customer's book. */
export function normalizeFraming(raw) {
  if (!raw || typeof raw !== 'object') return NO_CORRECTION;

  // An unrecognised edge means "leave it alone", never a guess: a wrong turn is worse than none.
  const rotate = TURN_FOR_UP[String(raw.up).toLowerCase()] ?? 0;
  const screenshot = raw.screenshot === true;

  // A crop is only ever honoured for something the model actually called a screen capture. Cropping
  // a plain photograph is not this module's job — the customer framed it the way they wanted it.
  let crop = null;
  if (screenshot && raw.crop && typeof raw.crop === 'object') {
    const { x, y, w, h } = raw.crop;
    const finite = [x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n));
    if (
      finite &&
      w >= MIN_CROP_FRACTION &&
      h >= MIN_CROP_FRACTION &&
      x >= 0 &&
      y >= 0 &&
      x + w <= 1.001 && // a model that rounds to 3 places can land a hair over 1
      y + h <= 1.001 &&
      !(w >= SKIP_CROP_ABOVE && h >= SKIP_CROP_ABOVE)
    ) {
      crop = { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
    }
  }

  if (rotate === 0 && !crop) return NO_CORRECTION;
  return { rotate, screenshot, crop };
}

/** Turn a fractional crop into whole pixels inside a `width`x`height` frame, or null if it collapses.
 *  Rounds outward-safe: never returns a box that leaves the image. */
export function cropToPixels(crop, width, height) {
  if (!crop || !width || !height) return null;
  const left = Math.max(0, Math.min(width - 1, Math.round(crop.x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round(crop.y * height)));
  const w = Math.max(1, Math.min(width - left, Math.round(crop.w * width)));
  const h = Math.max(1, Math.min(height - top, Math.round(crop.h * height)));
  if (w < 8 || h < 8) return null;
  return { left, top, width: w, height: h };
}

/**
 * Ask the light vision model how one photo should be framed.
 *
 * The image handed in should already have its EXIF rotation baked in, because the model is answering
 * about the pixels it is shown and the crop it returns is in that same frame.
 *
 * @param {object}   o
 * @param {object}   o.config     the resolved `config.ai` block
 * @param {Buffer}   o.buffer     the photo, EXIF-rotated
 * @param {function} [o.fetchImpl] injected for tests
 * @param {function} [o.describe]  injected for tests — defaults to the shared describeImage seam
 * @returns {Promise<{rotate:number, screenshot:boolean, crop:?object}>} never rejects
 */
export async function analyzeFraming({ config, buffer, fetchImpl, describe = describeImage } = {}) {
  if (!config?.enabled || !config?.apiKey || !buffer) return NO_CORRECTION;

  try {
    // A small JPEG copy: enough to read orientation and find a picture inside a screen capture,
    // and a fraction of the tokens a full-size original would cost.
    const small = await sharp(buffer)
      .resize({ width: ANALYSIS_PX, height: ANALYSIS_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    const text = await describe({
      config,
      referenceBase64: small.toString('base64'),
      referenceMime: 'image/jpeg',
      instruction: FRAMING_INSTRUCTION,
      fetchImpl,
    });

    return normalizeFraming(parseJsonObject(text));
  } catch {
    // Timeout, quota, a blocked prompt, a malformed reply — all the same answer. See the note above:
    // this step may improve a photo, it may never be the reason one fails.
    return NO_CORRECTION;
  }
}

// ---- trimming what the model leaves behind ----------------------------------
//
// The vision model reliably finds the CARD a photo sits on, not the photograph. Measured on a real
// order (1538_img0004, an Android gallery screenshot), its box still carried a white border, a
// "12 of 55" counter and the viewer's arrow buttons — which would print as a colouring page of
// somebody's user interface. Three sampled runs returned the same box to three decimals, so this is
// what the model believes, not a bad draw; more prompting did not move it.
//
// So the box is treated as a first pass and the edges are finished locally, where it is cheap and
// exact. Screen furniture is FLAT — a row of white card, or of caption bar, is nearly all one
// value. A photograph is not: its rows carry texture end to end. Measuring that directly separates
// the two far more sharply than any wording.

const ANALYSIS_W = 160; // wide enough to judge a row's texture, small enough to be free
const DETAIL_DELTA = 24; // luminance distance from the row median that counts as "something there"
const DETAIL_HIGH = 0.45; // above this a row is certainly photograph
const DETAIL_LOW = 0.12; // below this it is certainly screen furniture
const MAX_TRIM = 0.4; // never eat more than this fraction of an axis, whatever the measurements say

/** Per-line detail for every row (or column) of a raw RGB buffer: the fraction of pixels differing
 *  from that line's own median luminance. Median, not mean, so a caption's few dark glyphs on white
 *  cannot drag the baseline and disguise a flat bar as texture. */
function detailProfile(data, W, H, axis) {
  const n = axis === 'rows' ? H : W;
  const m = axis === 'rows' ? W : H;
  const out = new Array(n);
  const lum = new Float64Array(m);
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < m; b++) {
      const i = (axis === 'rows' ? a * W + b : b * W + a) * 3;
      lum[b] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    const med = [...lum].sort((x, y) => x - y)[m >> 1];
    let hits = 0;
    for (let b = 0; b < m; b++) if (Math.abs(lum[b] - med) > DETAIL_DELTA) hits++;
    out[a] = hits / m;
  }
  return out;
}

/** The span of one axis that is photograph, by hysteresis: find the region that is certainly picture,
 *  then grow outwards until the line is certainly furniture.
 *
 *  Two thresholds rather than one because a photograph's own edge rows can be genuinely flat — a
 *  bright window, a plain wall — and a single cut-off set high enough to remove a caption bar would
 *  also shave those off. Growing out from certainty keeps them and still stops at the bar. */
function photoSpan(profile) {
  let first = profile.findIndex((d) => d >= DETAIL_HIGH);
  if (first === -1) return null; // nothing that reads as photograph — leave the image alone
  let last = profile.length - 1;
  while (last > first && profile[last] < DETAIL_HIGH) last--;

  while (first > 0 && profile[first - 1] > DETAIL_LOW) first--;
  while (last < profile.length - 1 && profile[last + 1] > DETAIL_LOW) last++;

  const limit = Math.floor(profile.length * MAX_TRIM);
  if (first > limit || profile.length - 1 - last > limit) return null; // implausible — refuse rather than maul it
  return { start: first, end: last };
}

/**
 * Trim flat screen furniture from the edges of an already-cropped screenshot.
 *
 * Only ever called on an image the model called a screen capture, which is what makes the aggression
 * safe: a photograph with a genuinely blank border is not put through this.
 *
 * @returns {Promise<?{left:number, top:number, width:number, height:number}>} null to change nothing
 */
export async function trimFlatBorders(buffer) {
  try {
    const { data, info } = await sharp(buffer)
      .resize({ width: ANALYSIS_W, fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rows = photoSpan(detailProfile(data, info.width, info.height, 'rows'));
    const cols = photoSpan(detailProfile(data, info.width, info.height, 'cols'));
    if (!rows || !cols) return null;

    const full = await sharp(buffer).metadata();
    const sx = full.width / info.width;
    const sy = full.height / info.height;
    const left = Math.max(0, Math.round(cols.start * sx));
    const top = Math.max(0, Math.round(rows.start * sy));
    const width = Math.min(full.width - left, Math.round((cols.end - cols.start + 1) * sx));
    const height = Math.min(full.height - top, Math.round((rows.end - rows.start + 1) * sy));
    if (width < 8 || height < 8) return null;
    if (left === 0 && top === 0 && width === full.width && height === full.height) return null;
    return { left, top, width, height };
  } catch {
    return null;
  }
}

/** A short Czech note for the review grid, or null when nothing was done. */
export function framingLabel(correction) {
  if (!correction || (correction.rotate === 0 && !correction.crop)) return null;
  const parts = [];
  if (correction.rotate) parts.push(`otočeno o ${correction.rotate}°`);
  if (correction.crop) parts.push('oříznuto ze snímku obrazovky');
  return parts.join(', ');
}
