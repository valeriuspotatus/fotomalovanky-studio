// The operator points at a folder of orders, ticks the few they want, and lets the tool work
// through them one by one. Finished orders from last week must not pile up under the ones
// generating now.
//
//   node tools/queueSmoke.mjs [--keep]

import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { createReviewServer } from '../src/ui/server.js';
import { STATES, emptyManifest, setStatus, writeManifest } from '../src/manifest.js';

const keep = process.argv.includes('--keep');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10"/></svg>';
const IN_FOLDER = ['1479', '1510', '1523'];

const photo = (dest) => sharp({ create: { width: 160, height: 120, channels: 3, background: '#c8d8e8' } }).jpeg().toFile(dest);
const lineArt = (dest) =>
  sharp({ create: { width: 160, height: 120, channels: 3, background: '#ffffff' } })
    .composite([{ input: { create: { width: 160, height: 16, channels: 3, background: '#000000' } }, top: 50, left: 0 }])
    .png()
    .toFile(dest);

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fma-queue-'));
  const inbox = join(root, 'inbox');
  const outbox = join(root, 'outbox');
  for (const id of IN_FOLDER) {
    mkdirSync(join(inbox, id), { recursive: true });
    await photo(join(inbox, id, `${id}_img0001.jpeg`));
  }
  // Two orders finished earlier. Their photos are gone from the inbox; only the outbox knows them.
  for (const id of ['1400', '1401']) {
    const dir = join(outbox, id);
    mkdirSync(dir, { recursive: true });
    await photo(join(dir, 'old.jpg'));
    await lineArt(join(dir, 'old_bw.png'));
    writeFileSync(join(dir, 'old.svg'), SVG);
    writeManifest(dir, setStatus(emptyManifest(id), 'old', STATES.OK, 'ok'));
  }
  return { root, inbox, outbox };
}

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const fx = await fixture();
const config = {
  generator: { baseUrl: 'https://example.test/tok', mode: 'api', variant: '2509_1.5' },
  builder: { baseUrl: 'https://example.test', pdf: {} },
  paths: { inbox: fx.inbox, outbox: fx.outbox },
};
const ran = [];
const generator = {
  async generate(photoPath) {
    ran.push(photoPath);
    const d = mkdtempSync(join(tmpdir(), 'fma-q-gen-'));
    const base = photoPath.split(/[\\/]/).pop().replace(/\.jpe?g$/i, '');
    await photo(join(d, `${base}.jpeg`));
    await lineArt(join(d, `${base}_bw.png`));
    writeFileSync(join(d, `${base}.svg`), SVG);
    return { originalPath: join(d, `${base}.jpeg`), coloringPngPath: join(d, `${base}_bw.png`), coloringSvgPath: join(d, `${base}.svg`) };
  },
};
const builtFor = [];
const builder = {
  async buildPdf(orderDir, options) {
    builtFor.push(orderDir.split(/[\\/]/).pop());
    writeFileSync(options.outPdfPath, '%PDF-1.4\nstub\n');
    return { pdfPath: options.outPdfPath, pairs: 1 };
  },
};

// Start the server pointed nowhere in particular, so the page has to scan for itself. The stub
// line-art would trip the real QC tripwire, and a held order never reaches the builder — which is
// correct, and not what this harness is about.
const okQc = async () => ({ verdict: 'ok', reason: 'ok' });
// The folder the tool is configured to open at. Empty, like a real "new orders" folder before
// anything has been downloaded into it — so a freshly opened tool shows a clean page.
const CONFIGURED = join(fx.root, 'new-orders');
const { server } = createReviewServer({ config, inboxRoot: CONFIGURED, outboxRoot: fx.outbox, memoryRoot: fx.root, driver: generator, builder, qc: okQc });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`uncaught: ${e}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/409 \(Conflict\)/.test(m.text())) errors.push(m.text());
});

const orderIds = () => page.$$eval('#root section.order h2', (hs) => hs.map((h) => h.textContent.replace('Order ', '')));
const earlierIds = () => page.$$eval('#earlier section.order h2', (hs) => hs.map((h) => h.textContent.replace('Order ', '')));

try {
  // A different folder was opened once, weeks ago, and its path is still in localStorage. That
  // stale value is exactly what pointed this operator at their 439-order archive, so it must not
  // outrank the folder the tool is configured for.
  await page.addInitScript((dir) => localStorage.setItem('fma:inbox', dir), join(fx.root, 'used-once-weeks-ago'));
  await page.goto(url);
  await page.waitForSelector('#root');

  // Nothing chosen yet. Reopening the tool must not put last week's finished books on the desk.
  await page.waitForSelector('#root .empty');
  check('a freshly opened tool shows a clean page', (await orderIds()).length === 0);
  check('it opens at the configured folder, not a stale one used once', (await page.inputValue('#inbox')) === CONFIGURED);
  check('but does not open it', await page.locator('#queue').isHidden());
  check('the finished books are counted, not shown', /Order history \(2\)/.test(await page.locator('#history').textContent()));
  check('Go is offered, Stop is not — there is nothing to stop', (await page.locator('#run').isVisible()) && (await page.locator('#stop').isHidden()));

  // Point at the folder. Three orders is a handful, so they arrive ticked.
  await page.fill('#inbox', fx.inbox);
  await page.press('#inbox', 'Enter');
  await page.waitForSelector('#queue:not([hidden])');
  const boxes = await page.$$eval('#queue input[type=checkbox]', (cs) => cs.map((c) => [c.dataset.order, c.checked]));
  check('the folder scan lists every order', boxes.map((b) => b[0]).sort().join() === IN_FOLDER.join());
  check('the newest order is at the top, not buried', boxes.map((b) => b[0]).join() === '1523,1510,1479');
  check('a handful arrives ticked', boxes.every((b) => b[1]));
  check('and a handful is a list worth showing', await page.locator('#queue .list').isVisible());
  check('scanning spends nothing', ran.length === 0 && builtFor.length === 0);

  // The list folds away on request — the archive folder is 488 rows and buried the page.
  await page.click('#toggle-queue');
  await page.waitForFunction(() => document.querySelector('#queue .list')?.hidden === true);
  check('the folder list folds away', await page.locator('#queue .list').isHidden());
  check('and the header still says what is ticked', /3 ticked/.test(await page.locator('#queue .head').textContent()));
  await page.click('#toggle-queue');
  await page.waitForFunction(() => document.querySelector('#queue .list')?.hidden === false);

  await page.waitForFunction(() => document.querySelectorAll('#root section.order').length === 3);
  check('the grid now shows this folder, not the archive', (await orderIds()).sort().join() === IN_FOLDER.join());
  check('the finished orders are nowhere on the main page', (await earlierIds()).length === 0);
  check('but a button says how many there are', /Order history \(2\)/.test(await page.locator('#history').textContent()));

  await page.click('#history');
  await page.waitForFunction(() => document.querySelectorAll('#earlier section.order').length === 2);
  check('the history button brings them back', (await earlierIds()).sort().join() === '1400,1401');
  check('and offers to put them away again', /Hide history/.test(await page.locator('#history').textContent()));
  await page.click('#history');
  await page.waitForFunction(() => document.querySelectorAll('#earlier section.order').length === 0);

  // Untick one. It leaves both the queue and the grid.
  await page.uncheck('#queue input[data-order="1523"]');
  await page.waitForFunction(() => document.querySelectorAll('#root section.order').length === 2);
  check('unticking an order takes it out of the grid', (await orderIds()).sort().join() === '1479,1510');

  // Ticking queues an order; it does not start it. A spinning wheel here would tell the operator
  // the tool was working, and they would sit and wait for a batch nobody started.
  const idleSpinners = await page.locator('.tile .spin').count();
  check('a ticked order does not pretend to be working', idleSpinners === 0, `${idleSpinners} wheels spinning with no run`);
  check('it says what it is waiting for instead', /press Go to make it/.test(await page.locator('#root').textContent()));

  await page.click('#queue button[data-tick="none"]');
  await page.waitForFunction(() => document.querySelectorAll('#queue input:checked').length === 0);
  // Wipe any toast still on screen: waiting for ".err" would otherwise match an older one and
  // this check would pass, or fail, for the wrong reason entirely.
  await page.evaluate(() => {
    const t = document.querySelector('#toast');
    t.className = '';
    t.textContent = '';
  });
  await page.click('#run');
  let refusal = '';
  await page
    .waitForFunction(() => /tick at least one order/i.test(document.querySelector('#toast').textContent), null, { timeout: 6000 })
    .catch(() => {});
  refusal = await page.locator('#toast').textContent();
  check('Go with nothing ticked is refused', /tick at least one order/i.test(refusal), refusal || '(no toast)');
  check('and it really ran nothing', ran.length === 0);

  // Tick two and let them run, one after another.
  await page.check('#queue input[data-order="1479"]');
  await page.check('#queue input[data-order="1510"]');
  await page.waitForFunction(() => document.querySelectorAll('#queue input:checked').length === 2);
  await page.click('#run');
  // Wait for the run to actually *finish*: the button is still enabled the instant it is clicked,
  // so "not disabled" is true before the run has even begun.
  await page.waitForFunction(() => /\d+ done,/.test(document.querySelector('#runpanel')?.textContent ?? ''), null, { timeout: 40_000 });

  check('only the ticked orders were generated', ran.length === 2 && ran.every((p) => /1479|1510/.test(p)), ran.map((p) => p.split(/[\\/]/).pop()).join(', '));
  check('and only they were printed', builtFor.slice().sort().join() === '1479,1510', `built: [${builtFor.join(', ')}]`);
  check('the run log says what it left alone', /1 more you did not tick/.test(await page.locator('#runpanel').textContent()));

  // The archive folder: hundreds of orders. The list must not bury the page under all of them.
  const big = join(fx.root, 'archive');
  const many = Array.from({ length: 30 }, (_, i) => String(1300 + i)); // 1300 … 1329
  for (const id of many) {
    mkdirSync(join(big, id), { recursive: true });
    await photo(join(big, id, `${id}_img0001.jpeg`));
  }
  await page.fill('#inbox', big);
  await page.press('#inbox', 'Enter');
  await page.waitForFunction(() => document.querySelector('#queue .head')?.textContent.includes('30 orders'));
  // A big folder starts folded so it cannot bury the page; the operator opens it to look.
  check('a big folder keeps its list folded away', await page.locator('#queue .list').isHidden());
  await page.click('#toggle-queue');
  await page.waitForFunction(() => document.querySelector('#queue .list')?.hidden === false);
  // A folder this big is not auto-ticked, so no ticked order forces its way into the view: the
  // list is purely the most recent 20.
  await page.waitForSelector('#queue #show-all');
  let shown = await page.$$eval('#queue input[type=checkbox]', (cs) => cs.map((c) => c.dataset.order));
  check('a big folder shows only the recent orders', shown.length === 20, `${shown.length} shown of 30`);
  check('and the recent ones are the newest, top-first', shown[0] === '1329' && shown[19] === '1310');
  check('with a button offering the rest', /show all 30 — 10 older/.test(await page.locator('#queue #show-all').textContent()));

  await page.click('#queue #show-all');
  await page.waitForFunction(() => document.querySelectorAll('#queue input[type=checkbox]').length === 30);
  shown = await page.$$eval('#queue input[type=checkbox]', (cs) => cs.map((c) => c.dataset.order));
  check('show-all reveals every order', shown.length === 30 && shown[0] === '1329' && shown[29] === '1300');
  check('and then offers to fold back to the recent', /show only the recent/.test(await page.locator('#queue #show-all').textContent()));

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
