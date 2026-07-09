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
import { join } from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { createReviewServer } from '../src/ui/server.js';
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
const { server } = createReviewServer({
  config,
  inboxRoot: fx.inbox,
  outboxRoot: fx.outbox,
  driver: { generate: async () => { throw new Error('the smoke never spends GPU'); } },
});
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
