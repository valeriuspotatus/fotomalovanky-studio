// Browser smoke for the U4 review grid. Not part of `npm test` — it needs a real Chromium
// (`npx playwright install chromium`), and the offline suite must stay network- and browser-free.
//
//   node tools/gridSmoke.mjs [--keep] [--shot review-grid.png]
//
// Builds a throwaway order holding every tile state, drives the page the way the operator does,
// and asserts the things only a browser can prove: that the tiles needing attention come first,
// that a click reaches state.json, and that a *refused* action leaves the tile usable.

import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, extname } from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { createReviewServer } from '../src/ui/server.js';
import { approve as approveOutOfBand } from '../src/review.js';
import { STATES, emptyManifest, setStatus, writeManifest, readManifest, getStatus } from '../src/manifest.js';

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const shotAt = argv.indexOf('--shot');
const shot = shotAt >= 0 ? argv[shotAt + 1] : null;

const TOKEN = 'smoke-token-never-in-the-page';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10"/></svg>';

const CASES = [
  ['photo_ok', STATES.OK, 'ok'],
  ['photo_flagged', STATES.FLAGGED, 'near-blank'],
  ['photo_approved', STATES.APPROVED, 'operator approved'],
  ['photo_manual', STATES.MANUAL_IN_PROGRESS, 'awaiting a hand-repaired replacement'],
  ['photo_repaired', STATES.PENDING_REVIEW, 'ok'],
  ['photo_failed', STATES.FAILED, 'generator seam (poll): Generation failed on the GPU: worker lost'],
  ['photo_pending', null, null],
];

// Reaching a non-initial state legally means walking the state machine to it.
const WALK = {
  [STATES.MANUAL_IN_PROGRESS]: [STATES.FLAGGED, STATES.MANUAL_IN_PROGRESS],
  [STATES.PENDING_REVIEW]: [STATES.FLAGGED, STATES.MANUAL_IN_PROGRESS, STATES.PENDING_REVIEW],
  [STATES.APPROVED]: [STATES.OK, STATES.APPROVED],
};

const photo = (dest) => sharp({ create: { width: 400, height: 300, channels: 3, background: '#c8d8e8' } }).jpeg().toFile(dest);
const lineArt = (dest) =>
  sharp({ create: { width: 400, height: 300, channels: 3, background: '#ffffff' } })
    .composite([{ input: { create: { width: 400, height: 40, channels: 3, background: '#000000' } }, top: 130, left: 0 }])
    .png()
    .toFile(dest);

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fma-grid-smoke-'));
  const inbox = join(root, 'inbox', '1510');
  const orderDir = join(root, 'outbox', '1510');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(orderDir, { recursive: true });

  const manifest = emptyManifest('1510');
  for (const [base, status, reason] of CASES) {
    await photo(join(inbox, `${base}.jpeg`));
    if (status === null) continue; // never generated -> the "pending" tile
    await photo(join(orderDir, `${base}.jpg`));
    await lineArt(join(orderDir, `${base}_bw.png`));
    writeFileSync(join(orderDir, `${base}.svg`), SVG);
    for (const s of WALK[status] ?? [status]) setStatus(manifest, base, s, s === status ? reason : null);
  }
  writeManifest(orderDir, manifest);
  return { root, inbox: join(root, 'inbox'), outbox: join(root, 'outbox'), orderDir };
}

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const fx = await fixture();
const config = {
  generator: { baseUrl: `https://fotomalovanky-app.onrender.com/${TOKEN}/`, mode: 'api', variant: '2509_1.5' },
  builder: { baseUrl: 'https://example.test' },
  paths: { inbox: fx.inbox, outbox: fx.outbox },
};
// Stubs: the smoke never spends GPU and never launches the print browser.
const generator = {
  async generate(photoPath) {
    const base = basename(photoPath, extname(photoPath));
    const d = mkdtempSync(join(tmpdir(), 'fma-smoke-gen-'));
    await photo(join(d, `${base}.jpeg`));
    await lineArt(join(d, `${base}_bw.png`));
    writeFileSync(join(d, `${base}.svg`), SVG);
    return {
      originalPath: join(d, `${base}.jpeg`),
      coloringPngPath: join(d, `${base}_bw.png`),
      coloringSvgPath: join(d, `${base}.svg`),
    };
  },
};
const builtPdfs = [];
const builder = {
  async buildPdf(orderDir, options) {
    builtPdfs.push(options.outPdfPath);
    writeFileSync(options.outPdfPath, '%PDF-1.4\nstub\n');
    return { pdfPath: options.outPdfPath, pairs: 1 };
  },
};

const { server } = createReviewServer({ config, inboxRoot: fx.inbox, outboxRoot: fx.outbox, driver: generator, builder });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
// A refused action is *supposed* to fail its fetch, and the browser logs a console error for it.
// Anything else — a thrown exception, a 500, a broken image — is a real defect.
const errors = [];
page.on('pageerror', (e) => errors.push(`uncaught: ${e}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/409 \(Conflict\)/.test(m.text())) errors.push(m.text());
});

try {
  await page.goto(url);
  await page.waitForSelector('.tile');
  const tile = (base) => page.locator(`[data-key="1510/${base}"]`);

  const order = await page.$$eval('.tile', (ts) => ts.map((t) => t.dataset.base));
  check(
    'photos needing the operator are sorted first',
    order.slice(0, 4).join() === 'photo_failed,photo_flagged,photo_repaired,photo_manual',
    order.join(' > '),
  );

  check('every tile state renders', (await page.locator('.tile').count()) === CASES.length);

  const html = await page.content();
  check('the generator token never reaches the page', !html.includes(TOKEN));

  // A click has to land in state.json — that is what the builder gate reads.
  await tile('photo_flagged').getByRole('button', { name: 'Approve' }).click();
  await page.waitForFunction(() => document.querySelector('[data-key="1510/photo_flagged"] .pill')?.textContent === 'approved');
  check('approving a flagged photo writes state.json', getStatus(readManifest(fx.orderDir), 'photo_flagged') === STATES.APPROVED);

  // A refused action must explain itself and leave the tile usable.
  rmSync(join(fx.orderDir, 'photo_manual.svg'));
  await tile('photo_manual').getByRole('button', { name: "I've replaced it" }).click();
  await page.waitForSelector('#toast.show.err');
  const toast = await page.locator('#toast').textContent();
  check('a refused action explains itself', /No replacement found/.test(toast), toast.slice(0, 48) + '…');

  await page.waitForTimeout(400);
  check('a refused action leaves the tile usable', (await tile('photo_manual').locator('button:disabled').count()) === 0);
  check('the photo stays out for manual repair', getStatus(readManifest(fx.orderDir), 'photo_manual') === STATES.MANUAL_IN_PROGRESS);

  // These photo names carry no "_-_" text, so nothing is suggested and the title page has no words.
  check('an order with nothing to suggest says so', (await page.locator('.ded .note').textContent()).includes('no dedication'));

  // This text is what the customer reads first, so it has to survive a blur and a repaint.
  const ded = page.locator('.ded input');
  await ded.fill('Pro Barču, s láskou');
  await ded.blur(); // focusout is what saves it, not the typing
  await page.waitForFunction(() => !document.querySelector('.ded .note'));
  check('the title-page text reaches state.json', readManifest(fx.orderDir).dedication === 'Pro Barču, s láskou');

  // A background poll must not commit half-typed text as the dedication — but it must not freeze
  // the grid either. Type key by key (pressSequentially fires `input` only, so nothing is saved
  // yet), change the state underneath, and demand that the tile repaints *while* they type.
  await ded.focus();
  await page.keyboard.press('End');
  await ded.pressSequentially(' od rodiny');
  const typed = await ded.inputValue();
  approveOutOfBand(fx.orderDir, 'photo_ok'); // state.json now differs from what the page shows
  await page.waitForTimeout(2400); // two poll cycles

  check('a poll does not commit half-typed text', readManifest(fx.orderDir).dedication === 'Pro Barču, s láskou');
  check('the operator keeps focus while typing', await page.evaluate(() => !!document.activeElement?.matches?.('.ded input')));
  // The regression this exists for: a cursor resting in a title-page box used to freeze every
  // tile in every order, so a finished redo sat on screen reading "vectorize: tracing to svg".
  check(
    'the grid keeps repainting while the operator types',
    await page.evaluate(() => document.querySelector('[data-key="1510/photo_ok"] .pill')?.textContent === 'approved'),
  );
  check('their text survives the repaint', (await ded.inputValue()) === typed, typed);
  check(
    'their caret survives the repaint',
    await page.evaluate(() => document.activeElement.selectionStart === document.activeElement.value.length),
  );

  await ded.blur();
  await page.waitForFunction(() => !document.querySelector('.ded .note'));
  check('the text they typed through a repaint is saved on blur', readManifest(fx.orderDir).dedication === typed, typed);

  // ---- the Go button. Last, because a run mutates every order's state.json.
  await page.fill('#inbox', fx.inbox);
  await page.click('#run');
  await page.waitForSelector('#runpanel:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#run').disabled);

  check('Go locks itself while a run is going', await page.locator('#run').isDisabled());
  check(
    'a run locks the verdict buttons it would otherwise overwrite',
    (await page.locator('.tile button:not(:disabled)').count()) === 0,
  );

  await page.waitForFunction(() => !document.querySelector('#run').disabled, null, { timeout: 60_000 });
  await page.waitForTimeout(300);
  const log = await page.locator('#runpanel').textContent();

  // photo_manual is still out for manual repair, so this order is not builder-eligible.
  // Match the counts, not the words: "0 waiting for you" contains "waiting for you" too, so the
  // old /waiting for you/ test passed even when the run reported the order as FAILED.
  const counts = /(\d+) done, (\d+) waiting for you, (\d+) failed/.exec(log);
  check(
    'the run reports the order as waiting, not printed and not failed',
    counts?.[1] === '0' && counts?.[2] === '1' && counts?.[3] === '0',
    counts?.[0] ?? 'no run summary in the log',
  );
  check('the review gate kept the unfinished order out of the builder', builtPdfs.length === 0);
  check('the grid unlocks once the run is over', (await page.locator('.tile button:not(:disabled)').count()) > 0);

  check('no page errors', errors.length === 0, errors.join('; '));

  if (shot) {
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`\nscreenshot: ${shot}`);
  }
} finally {
  await browser.close();
  server.close();
  if (keep) console.log(`\nfixture kept at ${fx.root}`);
  else rmSync(fx.root, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
