// The manual crop, driven through a real browser against a real server.
//
// The unit tests prove the rectangle survives the pipeline; this proves an operator can draw one.
// It runs the whole path a person takes: open the card, drag a box on the customer's photo, save,
// and check that what ended up on disk is a rectangle in state.json — and that the customer's own
// file is the same bytes it was before anybody touched it.
//
//   node tools/cropSmoke.mjs [--keep]

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { createReviewServer } from '../src/ui/server.js';
import { STATES, emptyManifest, setStatus, setSource, writeManifest, readManifest, getManualCrop } from '../src/manifest.js';

const keep = process.argv.includes('--keep');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120"><path d="M0 0 L160 120"/></svg>';
const ORDER = '1701';
const BASE = `${ORDER}_img0001`;
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** A screenshot, as far as any edge measurement is concerned: texture with a flat white bar top and
 *  bottom — the status bar and the caption row of a phone gallery.
 *
 *  The texture is drawn COARSE (a small random field blown up) on purpose: trimFlatBorders measures
 *  on a 160px-wide copy, and per-pixel noise averages away to flat grey at that size, which would
 *  make the fixture read as one big status bar. Real photographs carry structure at this scale. */
async function screenshotish(dest, W = 480, H = 640, band = 90) {
  const cw = 24;
  const ch = Math.max(8, Math.round((cw * H) / W));
  const cells = Buffer.alloc(cw * ch * 3);
  let seed = 7;
  for (let i = 0; i < cells.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    cells[i] = (seed >> 16) & 0xff;
  }
  const texture = await sharp(cells, { raw: { width: cw, height: ch, channels: 3 } })
    .resize(W, H, { kernel: 'nearest' })
    .png()
    .toBuffer();
  const bar = await sharp({ create: { width: W, height: band, channels: 3, background: '#ffffff' } }).png().toBuffer();
  await sharp(texture)
    .composite([
      { input: bar, top: 0, left: 0 },
      { input: bar, top: H - band, left: 0 },
    ])
    .jpeg()
    .toFile(dest);
}

const lineArt = (dest) =>
  sharp({ create: { width: 160, height: 120, channels: 3, background: '#ffffff' } })
    .composite([{ input: { create: { width: 160, height: 16, channels: 3, background: '#000000' } }, top: 50, left: 0 }])
    .png()
    .toFile(dest);

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fma-crop-'));
  const inbox = join(root, 'inbox');
  const outbox = join(root, 'outbox');
  mkdirSync(join(inbox, ORDER), { recursive: true });
  const source = join(inbox, ORDER, `${BASE}.jpeg`);
  await screenshotish(source);

  const dir = join(outbox, ORDER);
  mkdirSync(dir, { recursive: true });
  await screenshotish(join(dir, `${BASE}.jpg`), 240, 320, 45);
  await lineArt(join(dir, `${BASE}_bw.png`));
  writeFileSync(join(dir, `${BASE}.svg`), SVG);
  let m = setStatus(emptyManifest(ORDER), BASE, STATES.OK, 'ok');
  m = setSource(m, BASE, source);
  writeManifest(dir, m);
  return { root, inbox, outbox, dir, source };
}

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const fx = await fixture();
const before = sha(fx.source);
const config = {
  generator: { baseUrl: 'https://example.test/tok', mode: 'api', variant: '2509_1.5', diffusionSteps: 8 },
  builder: { baseUrl: 'https://example.test', pdf: {} },
  paths: { inbox: fx.inbox, outbox: fx.outbox },
};

const generated = [];
const generator = {
  async generate(photoPath, settings = {}) {
    generated.push({ photoPath, correction: settings.correction ?? null });
    const d = mkdtempSync(join(tmpdir(), 'fma-crop-gen-'));
    await screenshotish(join(d, `${BASE}.jpeg`), 200, 200, 20);
    await lineArt(join(d, `${BASE}_bw.png`));
    writeFileSync(join(d, `${BASE}.svg`), SVG);
    return {
      originalPath: join(d, `${BASE}.jpeg`),
      coloringPngPath: join(d, `${BASE}_bw.png`),
      coloringSvgPath: join(d, `${BASE}.svg`),
      framing: settings.correction ?? null,
    };
  },
};
const okQc = async () => ({ verdict: 'ok', reason: 'ok' });
const okIntake = async () => ({ verdict: 'ok', findings: [], expected: null, uploaded: 1, unique: 1, emailCase: null });

const { server, shutdown } = createReviewServer({
  config,
  inboxRoot: fx.inbox,
  outboxRoot: fx.outbox,
  memoryRoot: fx.root,
  driver: generator,
  qc: okQc,
  intake: okIntake,
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/review`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`uncaught: ${e}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/409 \(Conflict\)/.test(m.text())) errors.push(m.text());
});

/** Drag on the crop overlay, in fractions of THE PICTURE — the stage around it is wider, and a
 *  fraction of the stage would start the drag in the margin beside the photo. */
async function dragBox(from, to) {
  const box = await page.locator('#pc-base').boundingBox();
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ((from[0] + to[0]) / 2), box.y + box.height * ((from[1] + to[1]) / 2), { steps: 6 });
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 6 });
  await page.mouse.up();
}

const stored = () => getManualCrop(readManifest(fx.dir), BASE);

try {
  await page.goto(url);
  await page.waitForSelector('.tile');

  // ---- the action is on the card, not buried ------------------------------------------------
  const cropBtn = page.locator(`.tile[data-base="${BASE}"] .acts button[data-crop]`);
  check('every photo card offers Oříznout', await cropBtn.isVisible());
  check('the card says which photo of the book it is', /1 \/ 1/.test(await page.locator('.tile .name').textContent()));

  await cropBtn.click();
  await page.waitForSelector('#pc[open]');
  await page.waitForFunction(() => document.querySelector('#pc-base')?.width > 0);
  check('the crop editor opens on the customer photo', true);

  const natural = await page.evaluate(() => ({ w: pc.nw, h: pc.nh, box: pc.box }));
  check('it loads the source at a size worth zooming into', natural.w >= 400, `${natural.w}x${natural.h}`);
  check('it opens on the whole photo, with nothing cropped away', natural.box === null);

  // ---- the screenshot warning and its proposal ------------------------------------------------
  await page.waitForSelector('#pc-shot:not([hidden])', { timeout: 10_000 });
  check('a screen capture is called out rather than silently cropped', /snímek obrazovky/i.test(await page.locator('#pc-shot').textContent()));
  await page.click('#pc-suggest');
  const proposed = await page.evaluate(() => ({ ...pc.box }));
  check('and a proposal can be dropped in', proposed.y > 0 && proposed.h < natural.h, JSON.stringify(proposed));

  // ---- dragging a box by hand ------------------------------------------------------------------
  await page.click('#pc-reset'); // back to the whole photo, so a drag draws rather than moves
  await dragBox([0.2, 0.3], [0.8, 0.8]);
  const dragged = await page.evaluate(() => ({ ...pc.box }));
  check('a drag draws the operator own box', Math.abs(dragged.x / natural.w - 0.2) < 0.06, JSON.stringify(dragged));

  // Dragging from inside moves it; dragging a corner resizes it.
  await dragBox([0.5, 0.5], [0.55, 0.5]);
  const moved = await page.evaluate(() => ({ ...pc.box }));
  check('a drag from inside moves the box', moved.x > dragged.x && Math.abs(moved.w - dragged.w) < 2, JSON.stringify(moved));

  const stage = await page.locator('#pc .pcstage').boundingBox();
  const corner = await page.evaluate(() => {
    const [x, y] = pcToStage(pc.box.x, pc.box.y);
    return { x, y };
  });
  await page.mouse.move(stage.x + corner.x, stage.y + corner.y);
  await page.mouse.down();
  await page.mouse.move(stage.x + corner.x - 30, stage.y + corner.y - 20, { steps: 6 });
  await page.mouse.up();
  const resized = await page.evaluate(() => ({ ...pc.box }));
  check(
    'a corner handle resizes rather than starting a new box',
    resized.w > moved.w && Math.abs(resized.x + resized.w - (moved.x + moved.w)) < 3,
    JSON.stringify(resized),
  );

  // Aspect presets constrain it.
  await page.click('#pc [data-ratio="a4p"]');
  const a4 = await page.evaluate(() => ({ ...pc.box }));
  check('A4 na výšku constrains the box to the page it prints on', Math.abs(a4.w / a4.h - 210 / 297) < 0.01, (a4.w / a4.h).toFixed(3));
  await page.click('#pc [data-ratio="free"]');

  // "Celá fotka" is the local reset.
  await page.click('#pc-reset');
  check('Celá fotka puts the whole photo back', (await page.evaluate(() => pc.box)) === null);

  // ---- cancel changes nothing ------------------------------------------------------------------
  await dragBox([0.1, 0.1], [0.6, 0.6]);
  await page.click('#pc-cancel');
  await page.waitForFunction(() => !document.querySelector('#pc').open);
  check('cancelling stores nothing at all', stored() === null);
  check('and leaves the customer photo untouched', sha(fx.source) === before);

  // ---- saving, and what it does --------------------------------------------------------------
  await cropBtn.click();
  await page.waitForSelector('#pc[open]');
  await page.waitForFunction(() => document.querySelector('#pc-base')?.width > 0);
  await page.waitForSelector('#pc-shot:not([hidden])', { timeout: 10_000 });
  await dragBox([0.1, 0.25], [0.9, 0.75]);
  const drawn = await page.evaluate(() => ({ ...pc.box, nw: pc.nw, nh: pc.nh }));
  await page.click('#pc-save');
  await page.waitForFunction(() => !document.querySelector('#pc').open);
  await page.waitForFunction(() => document.querySelectorAll('.tile').length > 0);

  const saved = stored();
  check('the crop is on disk as a rectangle', Boolean(saved), JSON.stringify(saved));
  check('and it is the rectangle that was drawn', saved && Math.abs(saved.y - drawn.y / drawn.nh) < 0.03, `${saved && saved.y.toFixed(3)} vs ${(drawn.y / drawn.nh).toFixed(3)}`);
  check('THE CUSTOMER PHOTO IS BYTE-IDENTICAL', sha(fx.source) === before);

  await page.waitForFunction(() => !document.querySelector('.tile .busy'), null, { timeout: 20_000 });
  const last = generated.at(-1);
  check('saving sent the photo straight back to the generator', generated.length === 1);
  check('which re-read the customer own file', last && last.photoPath === fx.source, last && last.photoPath);
  check('with the operator rectangle as the correction', Boolean(last && last.correction && last.correction.manual), JSON.stringify(last && last.correction));

  // ---- reopening, and reverting ----------------------------------------------------------------
  await page.waitForFunction(() => document.querySelector('.tile')?.dataset.mcrop !== undefined, null, { timeout: 20_000 });
  check('the card says the photo is cropped by hand', /ručně/.test(await page.locator('.tile').textContent()));

  check('and the note in the card links straight back into the editor', await page.locator(`.tile[data-base="${BASE}"] .why button[data-crop]`).isVisible());
  await cropBtn.click();
  await page.waitForSelector('#pc[open]');
  await page.waitForFunction(() => document.querySelector('#pc-base')?.width > 0);
  const reopened = await page.evaluate(() => ({ ...pc.box, nw: pc.nw, nh: pc.nh }));
  check('reopening shows the stored box, not the whole photo', Math.abs(reopened.h / reopened.nh - 0.5) < 0.06, (reopened.h / reopened.nh).toFixed(3));
  check('and offers the way back', await page.locator('#pc-clear').isVisible());

  // Rotation survives the round trip through the stored (un-turned) frame.
  await page.click('#pc-rotr');
  await page.waitForFunction(() => pc.rotate === 90);
  const turned = await page.evaluate(() => ({ rotate: pc.rotate, nw: pc.nw, nh: pc.nh, box: { ...pc.box } }));
  check('turning the photo swaps the frame', turned.nw === reopened.nh && turned.nh === reopened.nw);
  check('and carries the framing with it', Math.abs(turned.box.w / turned.nw - 0.5) < 0.06, (turned.box.w / turned.nw).toFixed(3));

  await page.click('#pc-clear');
  await page.waitForFunction(() => !document.querySelector('#pc').open);
  check('Zrušit uložený ořez is a complete revert', stored() === null);
  check('and still nothing was written to the customer photo', sha(fx.source) === before);

  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await shutdown();
  server.close();
  if (!keep) rmSync(fx.root, { recursive: true, force: true });
  else console.log(`\nfixture kept at ${fx.root}`);
}

const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
