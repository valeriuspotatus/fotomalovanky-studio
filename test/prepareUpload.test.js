import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { prepareImageForUpload } from '../src/generator/apiDriver.js';

/** A landscape-pixels JPEG carrying an EXIF orientation flag, the way a phone stores a photo it
 *  was holding upright. orientation 6 = "rotate 90° clockwise to view", i.e. it is really portrait. */
const sidewaysPortrait = (w, h, orientation = 6) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 120, b: 90 } } })
    .withMetadata({ orientation })
    .jpeg()
    .toBuffer();

const upright = (w, h) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 90, g: 140, b: 200 } } })
    .jpeg()
    .toBuffer();

const dims = async (buf) => {
  const m = await sharp(buf).metadata();
  return { w: m.width, h: m.height, orientation: m.orientation };
};

test('a portrait photo the phone stored sideways is uploaded upright', async () => {
  // 400x200 pixels, flagged "rotate 90" — a portrait photo. This is the img0002/img0003 case.
  const input = await sidewaysPortrait(400, 200, 6);
  assert.equal((await dims(input)).orientation, 6, 'the flag is there to begin with');

  const { buffer, changed, sideways } = await prepareImageForUpload(input);
  assert.ok(changed && sideways);

  const out = await dims(buffer);
  assert.equal(out.w, 200, 'the pixels are now portrait — the width and height have swapped');
  assert.equal(out.h, 400);
  assert.ok((out.orientation ?? 1) <= 1, 'and the flag is normalised, so nothing rotates it a second time');
});

test('every EXIF orientation the phone might use is honoured, not just rotate-90', async () => {
  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const input = await sidewaysPortrait(400, 200, orientation);
    const { buffer } = await prepareImageForUpload(input);
    const out = await dims(buffer);
    // 5..8 turn the image a quarter-turn (w/h swap); 1..4 keep it landscape.
    const expectPortrait = orientation >= 5;
    assert.equal(out.w < out.h, expectPortrait, `orientation ${orientation} should ${expectPortrait ? '' : 'not '}end up portrait`);
    assert.ok((out.orientation ?? 1) <= 1, `orientation ${orientation}: the flag is cleared`);
  }
});

test('an upright photo within size is passed through untouched — not recompressed', async () => {
  const input = await upright(800, 600);
  const { buffer, changed } = await prepareImageForUpload(input);
  assert.equal(changed, false);
  assert.equal(buffer, input, 'the very same bytes, so a good original keeps its quality');
});

test('PNG is canonicalized to JPEG before generator upload', async () => {
  const input = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const { buffer, changed } = await prepareImageForUpload(input);
  assert.equal(changed, true);
  assert.equal((await sharp(buffer).metadata()).format, 'jpeg');
});

test('a photo larger than the cap is downscaled, keeping its shape', async () => {
  const input = await upright(6000, 4500); // 4:3, far past the 2500px cap
  const { buffer, changed, tooBig } = await prepareImageForUpload(input, { maxDimension: 2500 });
  assert.ok(changed && tooBig);
  const out = await dims(buffer);
  assert.equal(Math.max(out.w, out.h), 2500, 'the long edge is the cap');
  assert.ok(Math.abs(out.w / out.h - 4 / 3) < 0.02, 'and the aspect ratio is preserved');
});

test('a big sideways photo is both turned upright and downscaled', async () => {
  // 5712x4284 flagged rotate-90 — exactly order 1524's img0002.
  const input = await sidewaysPortrait(5712, 4284, 6);
  const { buffer } = await prepareImageForUpload(input, { maxDimension: 2500 });
  const out = await dims(buffer);
  assert.ok(out.h > out.w, 'portrait, as it was shot');
  assert.equal(Math.max(out.w, out.h), 2500, 'and within the cap');
});

test('bytes that are not an image are left for the server to reject', async () => {
  await assert.rejects(() => prepareImageForUpload(Buffer.from('not a photo')));
});
