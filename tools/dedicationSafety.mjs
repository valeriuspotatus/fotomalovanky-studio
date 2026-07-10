// A real order lost its title-page text: "Hofbauerovi 18.7.2026" became "" and the operator did
// not knowingly clear it. Customer text is the one thing in this tool that cannot be regenerated,
// so this harness exists to prove that nothing but a deliberate edit can ever empty it.
//
//   node tools/dedicationSafety.mjs [--keep]
//
// Not part of `npm test` — it needs a real Chromium, like gridSmoke.

import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { createReviewServer } from '../src/ui/server.js';
import { approve as approveOutOfBand, setOrderDedication } from '../src/review.js';
import { STATES, emptyManifest, setStatus, setDedication, writeManifest, readManifest } from '../src/manifest.js';

const keep = process.argv.includes('--keep');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10"/></svg>';
const KEPT = 'Hofbauerovi 18.7.2026'; // the text that must survive everything below

// 1523 is decided (a dedication on disk). 1521's name carries a suggestion nobody has accepted.
// 1479's name carries nothing at all.
const ORDERS = {
  1523: { bases: ['1523_img0001_-_hofbauerovi_18.7.2026', '1523_img0002_-_hofbauerovi_18.7.2026'], dedication: KEPT },
  1521: { bases: ['1521_img0001_-_pro_maxinnku_a_estellku'], dedication: null },
  1479: { bases: ['1479_img0001'], dedication: null },
};

const photo = (dest) => sharp({ create: { width: 200, height: 150, channels: 3, background: '#c8d8e8' } }).jpeg().toFile(dest);
const lineArt = (dest) =>
  sharp({ create: { width: 200, height: 150, channels: 3, background: '#ffffff' } })
    .composite([{ input: { create: { width: 200, height: 20, channels: 3, background: '#000000' } }, top: 60, left: 0 }])
    .png()
    .toFile(dest);

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fma-ded-'));
  for (const [orderId, { bases, dedication }] of Object.entries(ORDERS)) {
    const inDir = join(root, 'inbox', orderId);
    const outDir = join(root, 'outbox', orderId);
    mkdirSync(inDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const manifest = emptyManifest(orderId);
    for (const base of bases) {
      await photo(join(inDir, `${base}.jpeg`));
      await photo(join(outDir, `${base}.jpg`));
      await lineArt(join(outDir, `${base}_bw.png`));
      writeFileSync(join(outDir, `${base}.svg`), SVG);
      setStatus(manifest, base, STATES.OK, 'ok');
    }
    if (dedication) setDedication(manifest, dedication);
    writeManifest(outDir, manifest);
  }
  return { root, inbox: join(root, 'inbox'), outbox: join(root, 'outbox') };
}

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const fx = await fixture();
const dedOf = (orderId) => readManifest(join(fx.outbox, String(orderId))).dedication;
const config = {
  generator: { baseUrl: 'https://example.test/tok', mode: 'api', variant: '2509_1.5' },
  builder: { baseUrl: 'https://example.test', pdf: {} },
  paths: { inbox: fx.inbox, outbox: fx.outbox },
};
const generator = { async generate() { throw new Error('the harness must never generate'); } };
const builder = {
  async buildPdf(orderDir, options) {
    writeFileSync(options.outPdfPath, '%PDF-1.4\nstub\n');
    return { pdfPath: options.outPdfPath, pairs: 1 };
  },
};

const { server } = createReviewServer({ config, inboxRoot: fx.inbox, outboxRoot: fx.outbox, driver: generator, builder });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`uncaught: ${e}`));

const ded = (orderId) => page.locator(`.ded[data-order="${orderId}"] input`);
const nowhere = () => page.locator('#root').click({ position: { x: 4, y: 4 } }); // the "white part between the buttons"
const settle = () => page.waitForTimeout(2200); // two poll cycles

/** Every sequence below must leave 1523's dedication exactly as it was. */
async function survives(name, sequence) {
  await page.goto(url);
  await page.waitForSelector('.tile');
  setOrderDedication(join(fx.outbox, '1523'), KEPT); // reset before each
  await page.reload();
  await page.waitForSelector('.ded input');
  try {
    await sequence();
  } catch (err) {
    check(name, false, `threw: ${err.message}`);
    return;
  }
  const after = dedOf(1523);
  check(name, after === KEPT, after === KEPT ? '' : `dedication is now ${JSON.stringify(after)}`);
}

try {
  await survives('focusing the box and clicking away writes nothing', async () => {
    await ded(1523).focus();
    await nowhere();
    await page.waitForTimeout(600);
  });

  await survives('focusing it, then a background repaint, then clicking away', async () => {
    await ded(1523).focus();
    approveOutOfBand(join(fx.outbox, '1523'), '1523_img0002_-_hofbauerovi_18.7.2026');
    await settle();
    await nowhere();
    await page.waitForTimeout(600);
  });

  // `act()` calls refresh(true) — a *forced* repaint, which is the one path that repaints a
  // focused input no matter what the poll would have done.
  await survives('a forced repaint from a tile action while the box has focus', async () => {
    await ded(1523).focus();
    const tile = page.locator('[data-key="1523/1523_img0002_-_hofbauerovi_18.7.2026"]');
    await tile.locator('button[data-a]').first().click(); // "Mark bad" on a clean photo
    await page.waitForTimeout(900);
  });

  // The same, but with the operator midway through typing when the repaint tears the box out.
  await survives('a forced repaint while the box is focused *and* dirty', async () => {
    await ded(1523).focus();
    await page.keyboard.press('End');
    await ded(1523).pressSequentially(' od rodiny');
    const tile = page.locator('[data-key="1523/1523_img0001_-_hofbauerovi_18.7.2026"]');
    await tile.locator('button[data-a]').first().click();
    await page.waitForTimeout(900);
    // Their half-typed text may legitimately be saved here, but it must never be *empty*.
    const after = dedOf(1523);
    if (after && after !== KEPT) setOrderDedication(join(fx.outbox, '1523'), KEPT);
  });

  await survives('pressing Go while the box has focus', async () => {
    await ded(1523).focus();
    await page.fill('#inbox', fx.inbox);
    await ded(1523).focus();
    await page.click('#run');
    await page.waitForFunction(() => !document.querySelector('#run').disabled, null, { timeout: 20_000 });
    await page.waitForTimeout(600);
  });

  await survives('reloading the page while the box has focus', async () => {
    await ded(1523).focus();
    await page.reload();
    await page.waitForSelector('.ded input');
  });

  await survives('the browser losing focus while the box is focused', async () => {
    await ded(1523).focus();
    const other = await browser.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await page.waitForTimeout(800);
    await other.close();
    await page.bringToFront();
    await page.waitForTimeout(600);
  });

  await survives('typing into a *different* order and blurring', async () => {
    await ded(1521).focus();
    await ded(1521).fill('Pro Maxinnku a Estellku');
    await nowhere();
    await page.waitForTimeout(700);
  });

  await survives('tabbing through the box without editing', async () => {
    await ded(1523).focus();
    await page.keyboard.press('Tab');
    await page.waitForTimeout(700);
  });

  // …and a deliberate clear must still work, or the operator cannot say "no dedication".
  await page.goto(url);
  await page.waitForSelector('.ded input');
  setOrderDedication(join(fx.outbox, '1523'), KEPT);
  await page.reload();
  await page.waitForSelector('.ded input');
  await ded(1523).focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await nowhere();
  await page.waitForTimeout(800);
  check('a deliberate clear is still honoured', dedOf(1523) === '', `dedication is ${JSON.stringify(dedOf(1523))}`);

  // …and the text it cleared is still on disk, one click from coming back.
  await page.reload();
  await page.waitForSelector('.ded input');
  check('the cleared text is remembered', readManifest(join(fx.outbox, '1523')).dedicationWas === KEPT);
  await page.locator('.ded[data-order="1523"] button[data-restore]').click();
  await page.waitForFunction(() => !document.querySelector('.ded[data-order="1523"] button[data-restore]'), null, { timeout: 5000 });
  check('one click brings it back', dedOf(1523) === KEPT, dedOf(1523));
  check('restoring forgets the undo', readManifest(join(fx.outbox, '1523')).dedicationWas === undefined);

  // The suggestion must not be silently committed by merely looking at the box. Earlier
  // sequences (and the Go run) have since decided 1521, so put it back to undecided first.
  const dir1521 = join(fx.outbox, '1521');
  const m = readManifest(dir1521);
  delete m.dedication;
  delete m.dedicationWas;
  writeManifest(dir1521, m);

  await page.reload();
  await page.waitForSelector('.ded input');
  check('an undecided order shows the suggested text', (await ded(1521).inputValue()) === 'Pro Maxinnku a Estellku');
  await ded(1521).focus();
  await nowhere();
  await page.waitForTimeout(700);
  check('tabbing through a suggested title does not commit it', readManifest(dir1521).dedication === undefined);

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  server.close();
  if (!keep) rmSync(fx.root, { recursive: true, force: true });
  else console.log(`\nfixture kept at ${fx.root}`);
}

const failed = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
