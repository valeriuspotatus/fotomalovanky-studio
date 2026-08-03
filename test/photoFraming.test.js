import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { analyzeFraming, normalizeFraming, cropToPixels, trimFlatBorders, framingLabel, NO_CORRECTION } from '../src/photoFraming.js';
import { prepareImageForUpload } from '../src/generator/apiDriver.js';

const AI = { enabled: true, apiKey: 'k', describeModel: 'gemini-flash-lite-latest' };
/** A describeImage stand-in that returns whatever the model is pretending to say. */
const says = (text) => async () => text;

// ---- normalizeFraming: the decision table -----------------------------------
// Every rejection here is a way a plausible-looking reply could ruin a customer's book.

test('a clean upright photo asks for nothing', () => {
  assert.equal(normalizeFraming({ up: 'top', screenshot: false, crop: null }), NO_CORRECTION);
});

test('the edge the heads point to becomes the turn that puts them back on top', () => {
  // Measured against the live model on every orientation of two real order photos: asking for an
  // angle put a 270-turned photo back upside down. Asking where the sky is did not.
  assert.equal(normalizeFraming({ up: 'left' }).rotate, 90);
  assert.equal(normalizeFraming({ up: 'bottom' }).rotate, 180);
  assert.equal(normalizeFraming({ up: 'right' }).rotate, 270);
  assert.equal(normalizeFraming({ up: 'TOP' }), NO_CORRECTION, 'an already-upright photo is left alone');
});

test('an edge nobody recognises turns the photo not at all, rather than guessing', () => {
  for (const up of ['sideways', '', 90, null, undefined, {}]) {
    assert.equal(normalizeFraming({ up }), NO_CORRECTION, `${JSON.stringify(up)} must not turn anything`);
  }
});

test('a crop is never applied to a plain photograph, however confident the box', () => {
  // The customer framed their own photo. Only a screen capture is ours to cut.
  const raw = { rotate: 0, screenshot: false, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } };
  assert.equal(normalizeFraming(raw), NO_CORRECTION);
});

test('a sliver crop is refused — cropping a face down to nothing is worse than not cropping', () => {
  const raw = { rotate: 0, screenshot: true, crop: { x: 0.4, y: 0.4, w: 0.05, h: 0.05 } };
  assert.equal(normalizeFraming(raw), NO_CORRECTION);
});

test('a crop escaping the frame is refused rather than clamped into something plausible', () => {
  assert.equal(normalizeFraming({ screenshot: true, crop: { x: 0.5, y: 0, w: 0.9, h: 0.9 } }), NO_CORRECTION);
  assert.equal(normalizeFraming({ screenshot: true, crop: { x: -0.1, y: 0, w: 0.8, h: 0.8 } }), NO_CORRECTION);
});

test('a whole-frame crop is skipped — there is no chrome worth a re-encode', () => {
  assert.equal(normalizeFraming({ screenshot: true, crop: { x: 0, y: 0, w: 1, h: 1 } }), NO_CORRECTION);
});

test('a real screenshot box survives, and a rotation can ride along with it', () => {
  const got = normalizeFraming({ up: 'left', screenshot: true, crop: { x: 0, y: 0.12, w: 1, h: 0.7 } });
  assert.equal(got.rotate, 90);
  assert.equal(got.screenshot, true);
  assert.deepEqual(got.crop, { x: 0, y: 0.12, w: 1, h: 0.7 });
});

test('junk of every shape is no correction, never a throw', () => {
  for (const raw of [null, undefined, 'nope', 42, [], { crop: 'yes' }, { screenshot: true, crop: {} }]) {
    assert.equal(normalizeFraming(raw), NO_CORRECTION, `${JSON.stringify(raw)} must be inert`);
  }
});

// ---- the model reply is untrusted text --------------------------------------

test('a fenced ```json reply is read, because the light model likes to fence', async () => {
  const got = await analyzeFraming({ config: AI, buffer: await red(40, 40), describe: says('```json\n{"up":"bottom","screenshot":false}\n```') });
  assert.equal(got.rotate, 180);
});

test('prose around the JSON is tolerated', async () => {
  const got = await analyzeFraming({ config: AI, buffer: await red(40, 40), describe: says('Sure! {"up":"left","screenshot":false} Hope that helps.') });
  assert.equal(got.rotate, 90);
});

test('an unparseable reply, a refusal, or a thrown call all mean leave the photo alone', async () => {
  const buffer = await red(40, 40);
  assert.equal(await analyzeFraming({ config: AI, buffer, describe: says('I cannot help with that.') }), NO_CORRECTION);
  assert.equal(await analyzeFraming({ config: AI, buffer, describe: says('') }), NO_CORRECTION);
  const boom = async () => { throw new Error('429 quota'); };
  assert.equal(await analyzeFraming({ config: AI, buffer, describe: boom }), NO_CORRECTION, 'a quota failure never fails the photo');
});

test('with no AI key or the block disabled, nothing is ever sent', async () => {
  const buffer = await red(40, 40);
  let called = false;
  const spy = async () => { called = true; return '{"up":"left"}'; };
  assert.equal(await analyzeFraming({ config: { enabled: false, apiKey: 'k' }, buffer, describe: spy }), NO_CORRECTION);
  assert.equal(await analyzeFraming({ config: { enabled: true, apiKey: '' }, buffer, describe: spy }), NO_CORRECTION);
  assert.equal(called, false, 'the customer photo never left the machine');
});

// ---- cropToPixels -----------------------------------------------------------

test('a fractional box becomes whole pixels that stay inside the frame', () => {
  assert.deepEqual(cropToPixels({ x: 0, y: 0.25, w: 1, h: 0.5 }, 1000, 2000), { left: 0, top: 500, width: 1000, height: 1000 });
  // Rounding at the far edge must not run off the end.
  const box = cropToPixels({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, 999, 999);
  assert.ok(box.left + box.width <= 999 && box.top + box.height <= 999);
});

// ---- the effect on real bytes ----------------------------------------------

/** A solid image with a distinctive stripe down the top edge, so orientation is measurable. */
async function red(w, h) {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#c02020' } }).jpeg().toBuffer();
}

test('a correction actually turns the pixels, and swaps the axes when it should', async () => {
  const src = await red(100, 40); // landscape
  const { buffer, changed } = await prepareImageForUpload(src, { correction: { rotate: 90, crop: null } });
  const m = await sharp(buffer).metadata();
  assert.equal(changed, true);
  assert.equal(m.width, 40, 'a 90° turn makes the wide photo tall');
  assert.equal(m.height, 100);
});

test('a screenshot crop cuts the chrome away before the turn', async () => {
  const src = await red(200, 400);
  // Keep the middle half vertically — the picture between a status bar and a nav bar.
  const { buffer } = await prepareImageForUpload(src, { correction: { rotate: 0, crop: { x: 0, y: 0.25, w: 1, h: 0.5 } } });
  const m = await sharp(buffer).metadata();
  assert.equal(m.width, 200);
  assert.equal(m.height, 200, 'half of 400');
});

test('no correction leaves a good photo byte-identical — never a needless recompress', async () => {
  const src = await red(100, 80);
  const { buffer, changed } = await prepareImageForUpload(src, { correction: NO_CORRECTION });
  assert.equal(changed, false);
  assert.equal(buffer, src, 'the very same buffer, not a re-encode of it');
});

// ---- trimming the furniture the model leaves behind -------------------------

/** Stand-in for photographic content: 8px blocks in three well-separated tones, varying along BOTH
 *  axes. Per-pixel noise will not do — it averages to flat grey at the 160px analysis width, which is
 *  exactly the "no texture" reading this module uses for screen furniture. Blocks survive the
 *  downscale the way a real photograph's features do. */
async function textured(W, H) {
  const TONE = [24, 128, 240];
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = TONE[(((x / 8) | 0) * 7 + ((y / 8) | 0) * 13) % 3];
      const i = (y * W + x) * 3;
      raw[i] = raw[i + 1] = raw[i + 2] = v;
    }
  }
  return sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

/** A fake screenshot: flat white bars top and bottom, textured "photograph" in the middle. */
async function withBars(photoH, barH) {
  const W = 200;
  const photo = await textured(W, photoH);
  return sharp({ create: { width: W, height: photoH + barH * 2, channels: 3, background: '#ffffff' } })
    .composite([{ input: photo, left: 0, top: barH }])
    .png()
    .toBuffer();
}

test('flat bars above and below a picture are measured away', async () => {
  const box = await trimFlatBorders(await withBars(300, 60));
  assert.ok(box, 'a screenshot with obvious furniture must be trimmed');
  assert.ok(box.top >= 45 && box.top <= 75, `top ${box.top} should land near the 60px bar`);
  assert.ok(box.height >= 270 && box.height <= 330, `height ${box.height} should be about the 300px picture`);
});

test('a photograph with no furniture is left exactly alone', async () => {
  assert.equal(await trimFlatBorders(await textured(200, 300)), null, 'nothing flat at any edge means nothing to trim');
});

test('an image that is entirely flat is refused rather than trimmed to a speck', async () => {
  const blank = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ffffff' } }).png().toBuffer();
  assert.equal(await trimFlatBorders(blank), null);
});

test('a picture behind a huge bar is refused — trimming past the cap is not a crop, it is damage', async () => {
  // Bars taller than the 40% cap: the measurement may be right, but acting on it would gut the page.
  assert.equal(await trimFlatBorders(await withBars(60, 240)), null);
});

test('unreadable bytes are no trim, never a throw', async () => {
  assert.equal(await trimFlatBorders(Buffer.from('not an image at all')), null);
});

// ---- what the operator is told ----------------------------------------------

test('the grid caption names what was done, and says nothing when nothing was', () => {
  assert.equal(framingLabel(NO_CORRECTION), null);
  assert.match(framingLabel({ rotate: 90, crop: null }), /otočeno o 90°/);
  assert.match(framingLabel({ rotate: 0, crop: { x: 0, y: 0, w: 1, h: 0.5 } }), /oříznuto/);
  assert.match(framingLabel({ rotate: 180, crop: { x: 0, y: 0, w: 1, h: 0.5 } }), /otočeno.*oříznuto/);
});
