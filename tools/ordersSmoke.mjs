// Objednávky and Tisková fronta, driven through a browser.
//
// The two things this is really guarding:
//   1. a filter's label names a status the backend can actually produce, and its count is the truth;
//   2. DOWNLOADING A PRINT BATCH DOES NOT MARK ANYTHING PRINTED. The press jams, the toner runs out,
//      half a run goes home unprinted — a board that decided otherwise would be lying to the only
//      person who could tell.
//
//   node tools/ordersSmoke.mjs [--keep]

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { createReviewServer } from '../src/ui/server.js';
import { STATES, emptyManifest, setStatus, setDedication, writeManifest } from '../src/manifest.js';

const keep = process.argv.includes('--keep');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120"><path d="M0 0 L160 120"/></svg>';

/** Four books built and unprinted (the queue), one still held for review (not the queue). */
const ORDERS = [
  { id: '2001', ded: 'Pro Jiříčka', built: true },
  { id: '2002', ded: 'Pro Terezku', built: true },
  { id: '2003', ded: '', built: true },
  { id: '2004', ded: 'Pro Aničku', built: true },
  { id: '2005', ded: 'Pro Honzíka', built: false },
];

const photo = (dest) => sharp({ create: { width: 200, height: 150, channels: 3, background: '#c8d8e8' } }).jpeg().toFile(dest);
const lineArt = (dest) =>
  sharp({ create: { width: 160, height: 120, channels: 3, background: '#ffffff' } })
    .composite([{ input: { create: { width: 160, height: 16, channels: 3, background: '#000000' } }, top: 50, left: 0 }])
    .png()
    .toFile(dest);

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fma-orders-'));
  const inbox = join(root, 'inbox');
  const outbox = join(root, 'outbox');
  mkdirSync(inbox, { recursive: true });
  for (const o of ORDERS) {
    const base = `${o.id}_img0001`;
    mkdirSync(join(inbox, o.id), { recursive: true });
    await photo(join(inbox, o.id, `${base}.jpeg`));
    const dir = join(outbox, o.id);
    mkdirSync(dir, { recursive: true });
    await photo(join(dir, `${base}.jpg`));
    await lineArt(join(dir, `${base}_bw.png`));
    writeFileSync(join(dir, `${base}.svg`), SVG);
    let m = setStatus(emptyManifest(o.id), base, o.built ? STATES.APPROVED : STATES.FLAGGED, 'ok');
    m = setDedication(m, o.ded);
    writeManifest(dir, m);
    if (o.built) writeFileSync(join(dir, `${o.id} Final.pdf`), `%PDF-1.4\n${o.id}\n%%EOF\n`);
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
  creatives: { dataDir: join(fx.root, 'cr') },
  shopify: { enabled: false, dataDir: join(fx.root, 'sh') },
  mail: { enabled: false },
  ai: { enabled: false },
  retentionDays: 30,
};
const { server, shutdown } = createReviewServer({
  config,
  inboxRoot: fx.inbox,
  outboxRoot: fx.outbox,
  memoryRoot: fx.root,
  driver: { async generate() { throw new Error('the smoke never generates'); } },
  qc: async () => ({ verdict: 'ok', reason: 'ok' }),
  intake: async () => ({ verdict: 'ok', findings: [], expected: null, uploaded: 1, unique: 1, emailCase: null }),
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(`uncaught: ${e}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/(40[0-9]|503) \(/.test(m.text())) errors.push(m.text());
});

const printedMarker = (id) => existsSync(join(fx.outbox, id, 'printed.json'));
const rowIds = (sel) => page.$$eval(sel, (tds) => tds.map((t) => t.textContent.trim()));

try {
  await page.goto(`${origin}/#orders`);
  await page.waitForSelector('#ordersBody tr .oid');

  // ---- filters ------------------------------------------------------------------------------
  const labels = await page.$$eval('#ordersFilters button', (bs) => bs.map((b) => b.textContent.replace(/\d+$/, '').trim()));
  check('the filters name the statuses the board really has', labels.join('|') === 'Vše|Potřebuje kontrolu|Generování|Připraveno k tisku|Vytištěno|Odesláno|Problém', labels.join('|'));

  const all = await rowIds('#ordersBody tr .oid');
  check('Vše shows every active order', all.length === ORDERS.length, all.join(','));

  await page.click('#ordersFilters button[data-filter="ready"]');
  const ready = await rowIds('#ordersBody tr .oid');
  check('Připraveno k tisku shows only the built books', ready.sort().join(',') === '2001,2002,2003,2004', ready.join(','));

  await page.click('#ordersFilters button[data-filter="check"]');
  const held = await rowIds('#ordersBody tr .oid');
  check('Potřebuje kontrolu shows only the one waiting', held.join(',') === '2005', held.join(','));

  const readyCount = await page.locator('#ordersFilters button[data-filter="ready"] .n').textContent();
  check('a filter counts the whole board, not what is on screen', readyCount === '4', readyCount);

  await page.click('#ordersFilters button[data-filter="all"]');

  // ---- search -------------------------------------------------------------------------------
  await page.fill('#ordersFind', 'Terez');
  await page.waitForTimeout(120);
  check('searching by title finds the order', (await rowIds('#ordersBody tr .oid')).join(',') === '2002');
  await page.fill('#ordersFind', '2004');
  await page.waitForTimeout(120);
  check('searching by order number finds it too', (await rowIds('#ordersBody tr .oid')).join(',') === '2004');
  await page.fill('#ordersFind', 'zzzz');
  await page.waitForTimeout(120);
  check('and nothing matching says so, rather than looking empty', await page.locator('#ordersBody .no-match').isVisible());
  await page.fill('#ordersFind', '');

  // ---- the print queue ------------------------------------------------------------------------
  await page.evaluate(() => { location.hash = 'queue'; });
  await page.waitForSelector('#queueBody input[data-pick]');
  const queued = await rowIds('#queueBody tr .oid');
  check('the queue holds every built, unprinted book', queued.sort().join(',') === '2001,2002,2003,2004', queued.join(','));
  check('the batch controls start disabled — nothing is selected', await page.locator('#queueZip').isDisabled());

  await page.click('#queueAll');
  await page.waitForTimeout(80);
  check('Vybrat vše ticks the run', (await page.$$eval('#queueBody input[data-pick]', (b) => b.filter((x) => x.checked).length)) === 4);
  check('and the buttons say how many', /\(4\)/.test(await page.locator('#queueZip').textContent()));

  await page.uncheck('#queueBody input[data-pick="2003"]');
  await page.waitForTimeout(80);
  check('un-ticking one row updates the count', /\(3\)/.test(await page.locator('#queuePrinted').textContent()));

  // ---- the download, and what it must NOT do ---------------------------------------------------
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#queueZip')]);
  const name = download.suggestedFilename();
  check('the batch downloads as print_batch_<date>.zip', /^print_batch_\d{4}-\d{2}-\d{2}\.zip$/.test(name), name);
  const zipPath = join(fx.root, name);
  await download.saveAs(zipPath);
  // Read the entry names straight out of the archive. A local file header is 30 bytes and the name
  // follows it, so the names sit in plain text 26 bytes past each PK signature — no zip
  // library needed to answer "what is in here".
  const raw = readFileSync(zipPath);
  const entries = [];
  for (let i = 0; i < raw.length - 30; i++) {
    if (raw[i] === 0x50 && raw[i + 1] === 0x4b && raw[i + 2] === 0x03 && raw[i + 3] === 0x04) {
      const len = raw.readUInt16LE(i + 26);
      if (len > 0 && len < 200) entries.push(raw.toString('utf8', i + 30, i + 30 + len));
    }
  }
  check('and holds one PDF per selected order, named orderID_title', entries.sort().join(',') === '2001_Pro-Jiricka.pdf,2002_Pro-Terezku.pdf,2004_Pro-Anicku.pdf', entries.join(','));
  check('the untitled book is named by its number alone', !entries.some((e) => e.startsWith('2003')));

  await page.waitForTimeout(400);
  check('DOWNLOADING MARKED NOTHING PRINTED', !ORDERS.some((o) => printedMarker(o.id)), ORDERS.filter((o) => printedMarker(o.id)).map((o) => o.id).join(','));
  const stillQueued = await rowIds('#queueBody tr .oid');
  check('and the queue is untouched by it', stillQueued.length === 4);

  // ---- marking printed is the separate, explicit act -------------------------------------------
  page.once('dialog', (d) => d.accept());
  await page.click('#queuePrinted');
  await page.waitForFunction(() => document.querySelectorAll('#queueBody tr .oid').length === 1, null, { timeout: 15_000 });
  check('marking printed asks first, then moves exactly the ticked books', printedMarker('2001') && printedMarker('2002') && printedMarker('2004'));
  check('and leaves the one that was un-ticked on the press', !printedMarker('2003'));
  check('the queue now holds only what is left', (await rowIds('#queueBody tr .oid')).join(',') === '2003');

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
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
