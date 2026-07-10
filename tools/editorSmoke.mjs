// Fixing a coloring page by hand, in the tool. The operator paints white over a mistake, crops
// the page, saves, and — if they hate it — puts the generated page back.
//
// The one thing this exists to prove: what they draw reaches `<base>.svg`, because that is the
// file the book is printed from. A raster-only fix would look perfect here and print broken.
//
//   node tools/editorSmoke.mjs [--keep]

import { mkdirSync, rmSync, writeFileSync, readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { createReviewServer } from '../src/ui/server.js';
import { editBackupPath } from '../src/review.js';
import { STATES, emptyManifest, setStatus, writeManifest, readManifest, getStatus } from '../src/manifest.js';

const keep = process.argv.includes('--keep');

// A white page with a fat black bar across the middle: the "mistake" to paint out. Shaped and
// sized like a real generator page — a viewBox, no width/height, and too big for the dialog, so
// the editor has to scale it down. A page small enough to fit would not test that it stays square.
const W = 1472;
const H = 1088;
const BAR = { y: 514, h: 60 };
const PAGE = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0.00 0.00 ${W}.00 ${H}.00">
<rect x="0" y="0" width="${W}" height="${H}" fill="#FFFFFF"/>
<rect x="0" y="${BAR.y}" width="${W}" height="${BAR.h}" fill="#010101"/>
</svg>`;

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fma-editor-'));
  const orderDir = join(root, 'outbox', '1510');
  mkdirSync(join(root, 'inbox', '1510'), { recursive: true });
  mkdirSync(orderDir, { recursive: true });

  await sharp({ create: { width: W, height: H, channels: 3, background: '#c8d8e8' } }).jpeg().toFile(join(root, 'inbox', '1510', 'a.jpeg'));
  await sharp({ create: { width: W, height: H, channels: 3, background: '#c8d8e8' } }).jpeg().toFile(join(orderDir, 'a.jpg'));
  writeFileSync(join(orderDir, 'a.svg'), PAGE);
  await sharp(Buffer.from(PAGE)).png().toFile(join(orderDir, 'a_bw.png'));
  writeManifest(orderDir, setStatus(emptyManifest('1510'), 'a', STATES.FLAGGED, 'near-blank'));

  return { root, inbox: join(root, 'inbox'), outbox: join(root, 'outbox'), orderDir };
}

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const fx = await fixture();
const svgNow = () => readFileSync(join(fx.orderDir, 'a.svg'), 'utf8');
const inkNow = async () => {
  const { data } = await sharp(readFileSync(join(fx.orderDir, 'a_bw.png')))
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data.reduce((n, v) => n + (v < 128 ? 1 : 0), 0) / data.length;
};

const config = {
  generator: { baseUrl: 'https://example.test/tok', mode: 'api', variant: '2509_1.5' },
  builder: { baseUrl: 'https://example.test', pdf: {} },
  paths: { inbox: fx.inbox, outbox: fx.outbox },
};
const okQc = async () => ({ verdict: 'ok', reason: 'ok' });
const { server } = createReviewServer({ config, inboxRoot: fx.inbox, outboxRoot: fx.outbox, qc: okQc });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`uncaught: ${e}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/409 \(Conflict\)/.test(m.text())) errors.push(m.text());
});

/** A closed <dialog> is hidden, not absent, so waitForSelector's default "visible" never lands. */
const closed = () => page.waitForFunction(() => !document.querySelector('#editor[open]'));

/** The tile is back in the review queue: the class is the hook, the wording is not. */
const reviewable = () => page.waitForSelector('.tile .pill.pending_review');

/** Drag across the canvas in fractions of its box, the way a hand does. */
async function drag(from, to) {
  const b = await page.locator('#e-canvas').boundingBox();
  await page.mouse.move(b.x + b.width * from[0], b.y + b.height * from[1]);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    await page.mouse.move(b.x + b.width * (from[0] + (to[0] - from[0]) * t), b.y + b.height * (from[1] + (to[1] - from[1]) * t));
  }
  await page.mouse.up();
}

try {
  await page.goto(url);
  await page.waitForSelector('.tile');
  const inkBefore = await inkNow();
  check('the fixture page has a black bar to paint out', inkBefore > 0.03, `${(inkBefore * 100).toFixed(1)}% ink`);

  await page.locator('.tile button[data-edit]').click();
  await page.waitForSelector('#editor[open]');
  check('"Fix by hand" opens the editor', true);
  check('saving nothing is not offered', await page.locator('#e-save').isDisabled());

  // The generator's SVGs carry a viewBox and no width/height, so the page has no size of its own.
  // Laid out wrong it is either invisible or squashed, and a stroke lands where nobody drew it.
  const shown = await page.locator('#e-img').boundingBox();
  check('the page is actually on screen to draw on', shown.width > 100 && shown.height > 100, `${Math.round(shown.width)}x${Math.round(shown.height)}`);
  check('a full-size page is scaled down to fit the dialog', shown.width < W, `${Math.round(shown.width)} < ${W}`);
  check('and scaling it down did not squash it', Math.abs(shown.width / shown.height - W / H) < 0.01, `aspect ${(shown.width / shown.height).toFixed(3)} vs ${(W / H).toFixed(3)}`);

  // Paint straight across the bar with a pencil wider than the bar is tall, so anything left
  // behind is a real failure and not a near miss.
  await page.locator('#e-size').fill('60');
  await drag([0.02, (BAR.y + BAR.h / 2) / H], [0.98, (BAR.y + BAR.h / 2) / H]);
  check('the pencil is now saveable', !(await page.locator('#e-save').isDisabled()));

  await page.click('#e-save');
  await closed();
  await reviewable();

  const svg = svgNow();
  check('the stroke reached the SVG the book prints', /class="fma-edit"/.test(svg) && /stroke="#FFFFFF"/.test(svg));
  const inkAfter = await inkNow();
  check('and the raster the operator sees was remade from it', inkAfter < 0.01, `${(inkBefore * 100).toFixed(1)}% -> ${(inkAfter * 100).toFixed(1)}% ink`);
  check('the page went back to the review queue', getStatus(readManifest(fx.orderDir), 'a') === STATES.PENDING_REVIEW);
  check('the generated page is kept outside the order folder', existsSync(editBackupPath(fx.orderDir, 'a')));
  check('the tile says it was fixed by hand', /fixed by hand/.test(await page.locator('.tile').textContent()));

  // Crop it to a different shape.
  await page.locator('.tile button[data-edit]').click();
  await page.waitForSelector('#editor[open]');
  check('an edited page offers to revert', await page.locator('#e-revert').isVisible());
  await page.click('#e-crop');
  await drag([0.2, 0.15], [0.7, 0.8]);
  await page.click('#e-save');
  await closed(); // the editor only closes once the server has written; the tile is already in review

  const cropped = svgNow().match(/viewBox="([^"]+)"/)[1].trim().split(/[\s,]+/).map(Number);
  const near = (got, want) => Math.abs(got - want) < 0.02 * want;
  check('the crop re-framed the page', near(cropped[2], W * 0.5) && near(cropped[3], H * 0.65), `viewBox ${cropped.join(' ')}`);

  // Put it all back.
  await page.locator('.tile button[data-edit]').click();
  await page.waitForSelector('#editor[open]');
  await page.click('#e-revert');
  await closed();
  await page.waitForFunction(() => !document.querySelector('.tile[data-edited]'));

  check('reverting puts the generated page back, byte for byte', svgNow() === PAGE);
  const inkBack = await inkNow();
  check('and the raster with it', Math.abs(inkBack - inkBefore) < 0.02, `${(inkBack * 100).toFixed(1)}% vs ${(inkBefore * 100).toFixed(1)}%`);
  check('a reverted page stops calling itself hand-fixed', !existsSync(editBackupPath(fx.orderDir, 'a')));

  // The pencil cannot fix everything, so the old repair-it-elsewhere route must stay reachable.
  await page.locator('.tile button[data-edit]').click();
  await page.waitForSelector('#editor[open]');
  await page.click('#e-elsewhere');
  await closed();
  await page.waitForSelector('.tile .pill.manual_in_progress');
  check('the page can still be handed to another program', getStatus(readManifest(fx.orderDir), 'a') === STATES.MANUAL_IN_PROGRESS);
  check('and that tile names the folder and waits for the replacement', /I've replaced it/.test(await page.locator('.tile').textContent()));

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  server.close();
  if (!keep) rmSync(fx.root, { recursive: true, force: true });
  else console.log(`\nfixture kept at ${fx.root}`);
}

const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
