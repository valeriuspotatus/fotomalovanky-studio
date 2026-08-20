import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { generateOrder } from '../src/batch.js';
import { prepareImageForUpload } from '../src/generator/apiDriver.js';
import { generationSource, setPhotoCrop, suggestPhotoCrop, reviewState, redo, ReviewError } from '../src/review.js';
import {
  ManifestError,
  normalizeManualCrop,
  correctionFromManualCrop,
  getManualCrop,
  getFraming,
  readManifest,
  writeManifest,
} from '../src/manifest.js';
import { photoBase } from '../src/organize.js';

// The manual crop, end to end. The one property every test here is really guarding: the customer's
// own file is never written to. A crop is four fractions in state.json, applied on the way OUT.

const CONFIG = {
  generator: { baseUrl: 'https://example.test/tok', mode: 'api', variant: '2509_1.5', diffusionSteps: 8 },
  paths: { inbox: './inbox', outbox: './outbox' },
};
const OK_QC = async () => ({ verdict: 'ok', reason: 'ok' });
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0 L8 8"/></svg>';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

class StubDriver {
  constructor() {
    this.settings = [];
    this.workDir = mkdtempSync(join(tmpdir(), 'fma-cropgen-'));
  }

  async generate(photoPath, settings = {}) {
    this.settings.push(settings);
    this.lastPhotoPath = photoPath;
    const base = photoBase(photoPath);
    const originalPath = join(this.workDir, `${base}.jpeg`);
    const coloringPngPath = join(this.workDir, `${base}_bw.png`);
    const coloringSvgPath = join(this.workDir, `${base}.svg`);
    writeFileSync(originalPath, 'echoed-jpeg');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toFile(coloringPngPath);
    writeFileSync(coloringSvgPath, SVG);
    // The live driver echoes back whatever correction it applied; mirror that.
    return { originalPath, coloringPngPath, coloringSvgPath, framing: settings.correction ?? null };
  }
}

async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fma-crop-'));
  const inbox = join(root, 'inbox');
  const outbox = join(root, 'outbox');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(outbox, { recursive: true });
  try {
    return await fn({ root, inbox, outbox });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A real JPEG in the inbox, so "the original is untouched" is a claim about actual bytes. */
async function seedPhoto(inbox, orderId, name, { width = 60, height = 40 } = {}) {
  const dir = join(inbox, orderId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  await sharp({ create: { width, height, channels: 3, background: '#3366aa' } }).jpeg().toFile(path);
  return { orderId, dirName: orderId, dir, photos: [path] };
}

/** A textured frame with a flat white band top and bottom — a screenshot, as far as any edge
 *  measurement is concerned. */
async function banded(W = 200, H = 200, band = 40) {
  const noise = Buffer.alloc(W * H * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 97) % 256;
  const bar = await sharp({ create: { width: W, height: band, channels: 3, background: '#ffffff' } }).png().toBuffer();
  return sharp(noise, { raw: { width: W, height: H, channels: 3 } })
    .composite([
      { input: bar, top: 0, left: 0 },
      { input: bar, top: H - band, left: 0 },
    ])
    .jpeg()
    .toBuffer();
}

// ---- the decision table ------------------------------------------------------

test('a crop outside the photo, or too small to print, is refused rather than stored', () => {
  assert.throws(() => normalizeManualCrop({ x: 0.9, y: 0, w: 0.4, h: 0.5 }), ManifestError);
  assert.throws(() => normalizeManualCrop({ x: -0.1, y: 0, w: 0.5, h: 0.5 }), ManifestError);
  assert.throws(() => normalizeManualCrop({ x: 0, y: 0, w: 0.005, h: 0.5 }), ManifestError);
  assert.throws(() => normalizeManualCrop({ x: 0, y: 0, w: 0.5, h: 0.5, rotate: 45 }), ManifestError);
  assert.throws(() => normalizeManualCrop({ x: 'a', y: 0, w: 0.5, h: 0.5 }), ManifestError);
  assert.throws(() => normalizeManualCrop(null), ManifestError);
});

test('the whole frame with no turn is not a crop — it is the photo, and nothing is stored', () => {
  assert.equal(normalizeManualCrop({ x: 0, y: 0, w: 1, h: 1 }), null);
  // …but the whole frame TURNED is a real decision and must survive.
  assert.deepEqual(normalizeManualCrop({ x: 0, y: 0, w: 1, h: 1, rotate: 90 }), { x: 0, y: 0, w: 1, h: 1, rotate: 90 });
});

test('a stored crop becomes the same {rotate, crop} shape the automatic framing produces', () => {
  const c = correctionFromManualCrop({ x: 0.1, y: 0.2, w: 0.5, h: 0.6, rotate: 90 });
  assert.deepEqual(c, { rotate: 90, screenshot: false, manual: true, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 } });
  assert.equal(correctionFromManualCrop(null), null);
});

// ---- persistence -------------------------------------------------------------

test('a crop is stored against its own photo, and clearing it leaves no trace', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = await seedPhoto(inbox, '1601', 'a.jpg');
    const driver = new StubDriver();
    const { orderDir } = await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver, qc: OK_QC });

    setPhotoCrop({ orderDir, base: 'a', crop: { x: 0, y: 0.25, w: 1, h: 0.5 } });
    const stored = getManualCrop(readManifest(orderDir), 'a');
    assert.deepEqual({ ...stored, at: undefined }, { x: 0, y: 0.25, w: 1, h: 0.5, rotate: 0, at: undefined });
    assert.match(stored.at, /^\d{4}-/, 'when it was drawn is recorded');

    assert.equal(setPhotoCrop({ orderDir, base: 'a', crop: null }), null);
    assert.equal(getManualCrop(readManifest(orderDir), 'a'), null);
  });
});

test('a crop for a photo the order does not have is refused, not written into the manifest', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = await seedPhoto(inbox, '1601', 'a.jpg');
    const driver = new StubDriver();
    const { orderDir } = await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver, qc: OK_QC });
    assert.throws(() => setPhotoCrop({ orderDir, base: 'not-a-photo', crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }), ReviewError);
    assert.equal(readManifest(orderDir).photos['not-a-photo'], undefined);
  });
});

test('one crop never lands on the neighbouring card', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const dir = join(inbox, '1602');
    mkdirSync(dir, { recursive: true });
    for (const n of ['a.jpg', 'b.jpg']) {
      await sharp({ create: { width: 40, height: 40, channels: 3, background: '#ffffff' } }).jpeg().toFile(join(dir, n));
    }
    const order = { orderId: '1602', dirName: '1602', dir, photos: [join(dir, 'a.jpg'), join(dir, 'b.jpg')] };
    const driver = new StubDriver();
    const { orderDir } = await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver, qc: OK_QC });

    setPhotoCrop({ orderDir, base: 'a', crop: { x: 0, y: 0, w: 0.5, h: 0.5 } });
    const m = readManifest(orderDir);
    assert.ok(getManualCrop(m, 'a'));
    assert.equal(getManualCrop(m, 'b'), null, 'the sibling card keeps its own (absent) crop');
  });
});

test('a photo that has never generated can still be cropped, and the crop waits for the first run', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = await seedPhoto(inbox, '1610', 'a.jpg');
    const orderDir = join(outbox, '1610');
    mkdirSync(orderDir, { recursive: true });
    // No manifest entry — nothing has generated this photo yet. That is the moment a screenshot is
    // worth catching, so it must be the moment the crop editor works.
    setPhotoCrop({ orderDir, base: 'a', crop: { x: 0, y: 0.2, w: 1, h: 0.6 }, bases: ['a'] });
    assert.ok(getManualCrop(readManifest(orderDir), 'a'));

    // …and the first run picks it up like any other.
    const driver = new StubDriver();
    await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver, qc: OK_QC });
    assert.equal(driver.settings[0].correction.crop.h, 0.6);
    assert.throws(() => setPhotoCrop({ orderDir, base: 'b', crop: { x: 0, y: 0, w: 1, h: 0.5 }, bases: ['a'] }), ReviewError);
  });
});

// ---- what generation actually does with it -----------------------------------

test('the next generation reads the stored crop and sends it as the correction', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = await seedPhoto(inbox, '1603', 'a.jpg');
    const driver = new StubDriver();
    const { orderDir } = await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver, qc: OK_QC });
    assert.equal(driver.settings[0].correction, undefined, 'an uncropped photo sends no correction at all');

    setPhotoCrop({ orderDir, base: 'a', crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.5, rotate: 270 } });
    // A fresh generateOrder is the batch re-running: the crop must apply there too, not only to the
    // one regeneration that followed the click.
    const manifest = readManifest(orderDir);
    manifest.photos.a.status = 'flagged';
    writeManifest(orderDir, manifest);
    await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver, qc: OK_QC });

    assert.deepEqual(driver.settings[1].correction, {
      rotate: 270,
      screenshot: false,
      manual: true,
      crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 },
    });
    assert.deepEqual(getFraming(readManifest(orderDir), 'a'), { rotate: 270, cropped: true, manual: true });
  });
});

test('regenerating exactly as it arrived still wins over a stored crop', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = await seedPhoto(inbox, '1604', 'a.jpg');
    const driver = new StubDriver();
    const { orderDir } = await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver, qc: OK_QC });
    setPhotoCrop({ orderDir, base: 'a', crop: { x: 0, y: 0, w: 0.5, h: 0.5 } });

    await redo({ config: CONFIG, orderDir, base: 'a', driver, qc: OK_QC, overrides: { noFraming: true } });
    const last = driver.settings.at(-1);
    assert.equal(last.noFraming, true, 'the driver checks this before it looks at any correction');
  });
});

test('generation reads the customer own upload, not the generator echo', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = await seedPhoto(inbox, '1605', 'a.jpg');
    const driver = new StubDriver();
    const { orderDir } = await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver, qc: OK_QC });
    assert.equal(generationSource(orderDir, 'a'), order.photos[0]);

    // Purge the inbox and the echo becomes the only source there is — never nothing.
    rmSync(join(inbox, '1605'), { recursive: true, force: true });
    assert.equal(generationSource(orderDir, 'a'), join(orderDir, 'a.jpg'));
  });
});

// ---- THE RULE: the customer's file is never written to -----------------------

test('cropping and regenerating leaves the customer original byte-identical', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = await seedPhoto(inbox, '1606', 'a.jpg');
    const before = sha(order.photos[0]);
    const driver = new StubDriver();
    const { orderDir } = await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver, qc: OK_QC });

    setPhotoCrop({ orderDir, base: 'a', crop: { x: 0.2, y: 0.2, w: 0.5, h: 0.5, rotate: 90 } });
    await redo({ config: CONFIG, orderDir, base: 'a', driver, qc: OK_QC });
    assert.equal(driver.lastPhotoPath, order.photos[0], 'it re-read the customer file');
    assert.equal(sha(order.photos[0]), before, 'and did not write to it');

    // Clearing the crop is a complete revert: there is no file to restore, so there is none to lose.
    setPhotoCrop({ orderDir, base: 'a', crop: null });
    await redo({ config: CONFIG, orderDir, base: 'a', driver, qc: OK_QC });
    assert.equal(driver.settings.at(-1).correction, undefined);
    assert.equal(sha(order.photos[0]), before);
  });
});

test('the board hands the page the stored crop and a source to draw it on', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = await seedPhoto(inbox, '1607', 'a.jpg');
    const driver = new StubDriver();
    const { orderDir } = await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver, qc: OK_QC });
    setPhotoCrop({ orderDir, base: 'a', crop: { x: 0, y: 0.3, w: 1, h: 0.4 } });

    const [board] = reviewState({ inboxRoot: inbox, outboxRoot: outbox, memoryRoot: join(outbox, '.mem') });
    const photo = board.photos[0];
    assert.equal(photo.manualCrop.h, 0.4);
    assert.equal(photo.files.source, order.photos[0], 'the crop editor is pointed at the customer own file');
  });
});

// ---- the cut itself ----------------------------------------------------------

test('the operator rectangle is cut exactly — no border trimming second-guesses it', async () => {
  // A photo with flat bands top and bottom: exactly what trimFlatBorders exists to eat. A crop the
  // MODEL proposed gets trimmed further; the operator's identical box must not be.
  const shot = await banded();
  const box = { x: 0, y: 0, w: 1, h: 1 };

  const manual = await prepareImageForUpload(shot, { correction: { rotate: 0, crop: box, manual: true } });
  assert.equal((await sharp(manual.buffer).metadata()).height, 200, 'the whole frame was asked for and kept');

  const guessed = await prepareImageForUpload(shot, { correction: { rotate: 0, crop: box } });
  assert.ok((await sharp(guessed.buffer).metadata()).height < 200, 'while the model own box is still finished off by measurement');
});

test('a stored rotation reaches the pixels', async () => {
  const src = await sharp({ create: { width: 60, height: 30, channels: 3, background: '#3366aa' } }).jpeg().toBuffer();
  const { buffer } = await prepareImageForUpload(src, { correction: { rotate: 90, crop: null, manual: true } });
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.width, 30);
  assert.equal(meta.height, 60);
});

test('a crop suggestion is offered for flat screen furniture and withheld otherwise', async () => {
  await fixture(async ({ root }) => {
    const shot = join(root, 'shot.jpg');
    writeFileSync(shot, await banded());
    const s = await suggestPhotoCrop(shot);
    assert.ok(s, 'the bars are found');
    assert.ok(s.y > 0.1 && s.h < 0.9, `the proposal drops them: ${JSON.stringify(s)}`);

    const noise = Buffer.alloc(200 * 200 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 97) % 256;
    const plain = join(root, 'plain.jpg');
    await sharp(noise, { raw: { width: 200, height: 200, channels: 3 } }).jpeg().toFile(plain);
    assert.equal(await suggestPhotoCrop(plain), null, 'an ordinary photograph is left alone');
    assert.equal(await suggestPhotoCrop(join(root, 'gone.jpg')), null, 'a missing file is no suggestion, not a crash');
  });
});
