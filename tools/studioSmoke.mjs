// Browser smoke for the studio dashboard's live order board (U8 read path). Not part of
// `npm test` — it needs a real Chromium (`npx playwright install chromium`), and the offline suite
// must stay network- and browser-free.
//
//   node tools/studioSmoke.mjs [--keep] [--shot studio.png]
//
// Builds a throwaway inbox/outbox holding one order in each board state, serves the real dashboard
// against it, and asserts the things only a browser can prove: that Objednávky renders the queue
// newest-first from /api/studio (no static analytics), that a held order surfaces under Potřebuje
// vás with its draft email and a copy button, that the marketing tabs still render their static
// content, that the board's Generovat / Vytvořit PDF buttons run one order via /api/_run, that the
// re-cut lifecycle runs print-then-post from the board (U9), and that the Generátor tile opens /review.

import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createReviewServer } from '../src/ui/server.js';
import { ORDER_BOARD_STATES } from '../src/studio.js';
import { STATES, emptyManifest, setStatus, setIntake, writeManifest } from '../src/manifest.js';

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const shotAt = argv.indexOf('--shot');
const shot = shotAt >= 0 ? argv[shotAt + 1] : null;

const TOKEN = 'studio-smoke-token-never-in-the-page';

/** One order on disk: inbox photos, outbox manifest statuses, optional intake hold + draft email,
 *  optional built PDF and lifecycle markers — exactly the facts the board derives its status from.
 *
 *  The markers follow the re-cut lifecycle (U9): `printed.json` is Jirka's, `sent.json` is the
 *  operator posting the book to the customer, and it comes AFTER the print. The retired
 *  `delivered.json` is deliberately not seeded anywhere — nothing reads it any more. */
function seedOrder(root, id, { photos = [], statuses = {}, intake = null, draftEmail = null, pdf = false, printed = false, sent = false }) {
  const inboxDir = join(root, 'inbox', id);
  mkdirSync(inboxDir, { recursive: true });
  for (const base of photos) writeFileSync(join(inboxDir, `${base}.jpeg`), 'jpeg-bytes');

  if (Object.keys(statuses).length || intake || pdf || printed || sent) {
    const outDir = join(root, 'outbox', id);
    mkdirSync(outDir, { recursive: true });
    const m = emptyManifest(id);
    for (const [base, st] of Object.entries(statuses)) setStatus(m, base, st, st);
    if (intake) setIntake(m, intake);
    writeManifest(outDir, m);
    if (draftEmail) writeFileSync(join(outDir, 'draft-email.txt'), draftEmail);
    if (pdf) writeFileSync(join(outDir, `${id} Final.pdf`), '%PDF-1.4\nstub\n');
    if (printed) writeFileSync(join(outDir, 'printed.json'), JSON.stringify({ at: 'smoke', by: 'Jirka' }));
    if (sent) writeFileSync(join(outDir, 'sent.json'), JSON.stringify({ at: 'smoke', by: 'David' }));
  }
}

const DRAFT = 'Komu: babicka@example.cz\nPředmět: Vaše fotky k omalovánkám\n\nDobrý den, chybí nám 1 fotka…';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fma-studio-smoke-'));
  // Deliberately seeded out of order to prove the board sorts oldest-first, not insertion order.
  seedOrder(root, '1600', { photos: ['a'] }); // queued — nothing generated
  // Printed AND posted to the customer: the only terminal state now, and the only one the board hides.
  seedOrder(root, '1523', { photos: ['a'], statuses: { a: STATES.OK }, pdf: true, printed: true, sent: true }); // sent
  // Printed but NOT yet posted. Under the old lifecycle this was the end of the line and was hidden;
  // it is now the operator's next job, so it has to be visible on the active board with a "send" action.
  seedOrder(root, '1525', { photos: ['a'], statuses: { a: STATES.OK }, pdf: true, printed: true }); // printed
  seedOrder(root, '1479', {
    photos: ['a', 'b'],
    intake: { verdict: 'hold', override: false, unique: 1, expected: 2, findings: [{ check: 'count', verdict: 'hold' }] },
    draftEmail: DRAFT,
  }); // held -> Potřebuje vás
  seedOrder(root, '1522', { photos: ['a'], statuses: { a: STATES.OK }, pdf: true }); // ready-to-print
  seedOrder(root, '1521', { photos: ['a', 'b'], statuses: { a: STATES.OK, b: STATES.FLAGGED } }); // pending-review
  // Every photo approved but no book on disk yet => APPROVED, the N1 split's other half. The fixture
  // had no order in this state, so nothing covered the "Vytvořit PDF" CTA or the #kpi-ready binding.
  seedOrder(root, '1524', { photos: ['a'], statuses: { a: STATES.OK } }); // approved — awaiting the PDF build
  return { root, inbox: join(root, 'inbox'), outbox: join(root, 'outbox') };
}

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const fx = fixture();
const config = {
  generator: { baseUrl: `https://fotomalovanky-app.onrender.com/${TOKEN}/`, mode: 'api', variant: '2509_1.5' },
  builder: { baseUrl: 'https://example.test' },
  paths: { inbox: fx.inbox, outbox: fx.outbox },
  // /api/creatives/calendar reads config.creatives.dataDir unguarded — without this the tab's fetch
  // 500s and only shows up as a console error, which the "no page errors" check then trips over.
  creatives: { dataDir: join(fx.root, 'creatives') },
};
const { server } = createReviewServer({ config, inboxRoot: fx.inbox, outboxRoot: fx.outbox, memoryRoot: fx.root, driver: { generate: async () => {} } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`uncaught: ${e}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

try {
  await page.goto(`${origin}/`);
  await page.waitForSelector('#v-home.on .kpis .kpi');
  // The KPI strip is live from /api/studio. #kpi-ready is "Připraveno pro PDF" = counts.approved
  // (renderHome), NOT ready-to-print — the N1 split rebound it and this smoke was never updated, which
  // is why it timed out here. The fixture now seeds exactly one approved order (1524).
  await page.waitForFunction(() => document.querySelector('#kpi-ready')?.textContent === '1');

  // --- home is the operational dashboard: a 5-KPI strip bound to the board, not the old analytics ---
  check('the home KPI strip shows the board states', (await page.locator('#v-home.on .kpis .kpi').count()) === 5);
  check('the home KPIs bind live counts (approved, awaiting PDF = 1)', (await page.locator('#kpi-ready').textContent()).trim() === '1');
  const homeHtml = await page.content();
  check('home is the dashboard, not the old analytics', !homeHtml.includes('217710') && !homeHtml.includes('AOV'));
  check('the studio token never reaches the page', !homeHtml.includes(TOKEN));

  // --- the Proton inbox tile fetches /api/mail and renders its offline state when mail is off ---
  await page.waitForFunction(() => /Proton/.test(document.querySelector('#mailBody')?.textContent || ''));
  check(
    'the Proton inbox tile shows a not-configured state when mail is off',
    (await page.locator('#v-home.on #mailCard').textContent()).includes('není nastaven'),
  );

  // The client STATUS map must label every server board state, or a real status renders as a raw
  // grey key and vanishes from the KPI strip. Guards the two lists against drift (Phase 2 adds states).
  const clientStates = await page.evaluate(() => Object.keys(STATUS));
  const serverStates = Object.values(ORDER_BOARD_STATES);
  check(
    'every server board status has a client label',
    serverStates.every((s) => clientStates.includes(s)),
    `server: ${serverStates.join(',')} | client: ${clientStates.join(',')}`,
  );

  // --- Kreativy studio: the deterministic layered template engine ---
  await page.evaluate(() => go('creatives'));
  // The 5 template families load from /api/studio/templates and one is auto-selected.
  await page.waitForFunction(() => document.querySelectorAll('#v-creatives.on #cvTemplates .cv-tpl').length >= 5);
  check('Kreativy studio lists the 5 template families', (await page.locator('#v-creatives.on #cvTemplates .cv-tpl').count()) === 5);
  check('Kreativy studio auto-selects a family', (await page.locator('#v-creatives.on #cvTemplates .cv-tpl.on').count()) === 1);
  check('Kreativy studio offers feed/story/landscape formats', (await page.locator('#v-creatives.on #cvFormats .cv-chip').count()) === 3);
  check('Kreativy studio builds copy fields for the family', (await page.locator('#v-creatives.on #cvFields .cv-field').count()) >= 1);
  check('Kreativy studio mounts a live preview frame', (await page.locator('#v-creatives.on #cvFrame').count()) === 1);
  // The QC pill renders after an async /api/studio/validate fetch, so wait for it before asserting.
  await page.waitForFunction(() => document.querySelector('#v-creatives.on #cvQc .cv-qc-pill'), { timeout: 5000 });
  check('Kreativy studio shows a QC status pill', (await page.locator('#v-creatives.on #cvQc .cv-qc-pill').count()) === 1);
  check(
    'Kreativy studio exposes the AI image generator',
    (await page.locator('#v-creatives.on #cvGenerate').count()) === 1 && (await page.locator('#v-creatives.on #cvPrompt').count()) === 1,
  );
  // Switching family swaps the composition: pick the 5th (Reference zákazníka) and confirm it selects.
  await page.locator('#v-creatives.on #cvTemplates .cv-tpl').nth(4).click();
  await page.waitForFunction(() => document.querySelectorAll('#v-creatives.on #cvTemplates .cv-tpl')[4].classList.contains('on'));
  check('switching template family updates the selection', (await page.locator('#v-creatives.on #cvTemplates .cv-tpl').nth(4).getAttribute('class')).includes('on'));
  check('Sdělení tab is gone from the sidebar', (await page.locator('#nav a[data-view="sdeleni"]').count()) === 0);

  // --- Kalendář: the calendar opens on the REAL current month (today is pinned to new Date()) ---
  await page.evaluate(() => go('calendar'));
  await page.waitForSelector('#v-calendar.on #calGridBig .d.clickable');
  const MON_NOM = ['Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen', 'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec'];
  const now = new Date();
  const expectLabel = `${MON_NOM[now.getMonth()]} ${now.getFullYear()}`;
  check('the calendar opens on the real current month', (await page.locator('#calLabelBig').textContent()).trim() === expectLabel);
  // Marked days name their primary event in the square (not just anonymous dots).
  check('big calendar days carry an event label', (await page.locator('#calGridBig .d .ev-label').count()) > 0);
  // Navigate forward until a target month's label shows (year-agnostic: every month carries the plan).
  const nextBtn = page.locator('#v-calendar.on .cal .top .nav-btns button[aria-label="Další"]');
  const gotoMonthName = async (name) => {
    for (let i = 0; i < 13; i++) {
      if ((await page.locator('#calLabelBig').textContent()).trim().startsWith(name + ' ')) return true;
      await nextBtn.click();
      await page.waitForTimeout(50);
    }
    return false;
  };

  // Days are clickable and the detail shows that day's events. July 14 = a creative launch (LANE).
  check('the next-month button navigates the year', await gotoMonthName('Červenec'));
  await page.locator('#v-calendar.on #calGridBig .d.clickable', { hasText: '14' }).first().click();
  await page.waitForFunction(() => /Spuštění/.test(document.querySelector('#dayBody')?.textContent || ''));
  check('clicking a calendar day shows that day’s events', (await page.locator('#dayTitle').textContent()).includes('14'));

  // Srpen 8 = Mezinárodní den koček, a marketing occasion carrying its angle + a "make a creative" link
  await gotoMonthName('Srpen');
  await page.locator('#v-calendar.on #calGridBig .d.clickable', { hasText: '8' }).first().click();
  await page.waitForFunction(() => /koček/.test(document.querySelector('#dayBody')?.textContent || ''));
  check('a marketing occasion shows its persona/angle', /Majitelé koček/.test(await page.locator('#dayBody').textContent()));
  check('a marketing occasion offers a jump to Kreativy', (await page.locator('#dayBody .de-cta').count()) > 0);
  // the upcoming panel lists opportunities from the plan, and clicking one jumps to its day
  check('upcoming opportunities are listed', (await page.locator('#upListBig .up-item').count()) > 0);
  // the evergreen idea bank (page 2 of the plan) renders grouped cards and jumps to Kreativy
  check('evergreen ideas render grouped cards', (await page.locator('#evergreenList .eg-cat').count()) === 6 && (await page.locator('#evergreenList .eg-item').count()) >= 20);
  await page.locator('#evergreenList .eg-item').first().click();
  await page.waitForSelector('#v-creatives.on');
  check('clicking an evergreen idea opens Kreativy', true);

  // --- Pošta tab: a dedicated sidebar tab that opens the full two-pane inbox ---
  check('the Pošta tab is in the sidebar', (await page.locator('#nav a[data-view="mail"]').count()) === 1);
  await page.evaluate(() => go('mail'));
  await page.waitForSelector('#v-mail.on .mail-app #mailTabCompose');
  await page.waitForFunction(() => (document.querySelector('#mailTabList')?.textContent || '').trim().length > 0);
  check('the Pošta tab opens the inbox pane with a compose button', (await page.locator('#v-mail.on #mailTabCompose').count()) === 1 && (await page.locator('#v-mail.on #mailTabRead').count()) === 1);
  check('the Pošta tab renders the mailbox state (offline here)', /Proton|nastaven|Žádné/.test(await page.locator('#mailTabList').textContent()));

  // --- Objednávky: the live order table from /api/studio, oldest-first, with sent orders hidden ---
  await page.evaluate(() => go('orders'));
  await page.waitForSelector('#v-orders.on #ordersBody .oid');
  const badgeIn = async (idList, id) => {
    const i = idList.indexOf(id);
    return (await page.locator('#v-orders.on #ordersBody tr').nth(i).locator('.chip').textContent()).trim();
  };

  const activeIds = await page.$$eval('#v-orders.on #ordersBody .oid', (ns) => ns.map((n) => n.textContent.trim()));
  // 1523 is posted to the customer (sent); the active board hides that and nothing else — 1525 is
  // printed but still to post, which is work, so it stays. The rest list NEWEST-first (renderOrders'
  // byNewest — "the one you just made is right there"); Potřebuje vás is the view that stayed oldest-first.
  check('the active board hides only dispatched orders, newest-first', activeIds.join() === '1600,1525,1524,1522,1521,1479', activeIds.join(' > '));
  check('a built, unprinted order reads ready-to-print', (await badgeIn(activeIds, '1522')) === 'připraveno k tisku');
  check('a printed but undispatched order stays on the board as vytištěno', (await badgeIn(activeIds, '1525')) === 'vytištěno');
  check('a flagged order reads pending-review', (await badgeIn(activeIds, '1521')) === 'ke kontrole');
  check('an ungenerated order reads queued', (await badgeIn(activeIds, '1600')) === 've frontě');
  check('an all-approved order with no book reads approved', (await badgeIn(activeIds, '1524')) === 'schváleno');
  // The two actions in their new order: a built book offers the PRINT mark, a printed one the POST mark.
  check(
    'the board offers Označit vytištěno on a built book and Označit odeslané on a printed one',
    (await page.locator('#v-orders.on #ordersBody tr', { has: page.locator('.oid', { hasText: '1522' }) }).locator('.act-printed').count()) === 1 &&
      (await page.locator('#v-orders.on #ordersBody tr', { has: page.locator('.oid', { hasText: '1525' }) }).locator('.act-sent').count()) === 1,
  );

  // --- the board drives the generator itself: the two states that used to dead-end at /review ---
  // /api/_run is intercepted, not served: startRun's `only` path is unit-covered, and a real run here
  // would reach for RunPod. What this proves is the wiring — that the right button sends the right
  // order, and never a bulk run nobody asked for.
  const runCalls = [];
  await page.route('**/api/_run', (r) => {
    runCalls.push(JSON.parse(r.request().postData() || '{}'));
    r.fulfill({ status: 202, contentType: 'application/json', body: '{"started":true}' });
  });
  const rowFor = (id) => page.locator('#v-orders.on #ordersBody tr', { has: page.locator('.oid', { hasText: id }) });
  check('a queued order offers Generovat on the board', (await rowFor('1600').locator('.act-generate').count()) === 1);
  check('an approved order offers Vytvořit PDF on the board', (await rowFor('1524').locator('.act-buildpdf').count()) === 1);
  check('no board action dead-ends at /review any more', (await page.locator('#v-orders.on #ordersBody a[href="/review"]').count()) === 0);

  await rowFor('1600').locator('.act-generate').click();
  await page.waitForFunction(() => true);
  check('Generovat runs only that order, generate-only', JSON.stringify(runCalls[0]) === '{"only":["1600"],"buildPdfs":false}', JSON.stringify(runCalls[0]));
  await rowFor('1524').locator('.act-buildpdf').click();
  check('Vytvořit PDF runs only that order, with the build', JSON.stringify(runCalls[1]) === '{"only":["1524"],"buildPdfs":true}', JSON.stringify(runCalls[1]));
  await page.unroute('**/api/_run');

  // The "show done" toggle counts and reveals the dispatched orders. Only 1523 is done — 1525 is
  // printed, which is no longer the end of the line.
  check('a toggle counts only the dispatched orders', (await page.locator('#doneToggle #toggleDone').textContent()).includes('(1)'));
  await page.locator('#doneToggle #toggleDone').click();
  await page.waitForFunction(() => document.querySelectorAll('#v-orders.on #ordersBody .oid').length === 7);
  const allIds = await page.$$eval('#v-orders.on #ordersBody .oid', (ns) => ns.map((n) => n.textContent.trim()));
  check('revealing done shows the dispatched order as sent to the customer', (await badgeIn(allIds, '1523')) === 'odesláno zákazníkovi');

  check('the board carries no hardcoded order data', !(await page.locator('#v-orders.on #ordersBody').textContent()).includes('218k'));

  // --- the re-ordered lifecycle, driven from the board: print first, then post ---
  await page.locator('#doneToggle #toggleDone').click(); // hide done again
  await page.waitForFunction(() => document.querySelectorAll('#v-orders.on #ordersBody .oid').length === 6);

  // 1. A built book is marked PRINTED. It stays on the board — printed is not terminal any more.
  await page
    .locator('#v-orders.on #ordersBody tr', { has: page.locator('.oid', { hasText: '1522' }) })
    .locator('.act-printed')
    .click();
  await page.waitForFunction(
    () => (Array.from(document.querySelectorAll('#v-orders.on #ordersBody tr')).find((tr) => tr.querySelector('.oid')?.textContent.trim() === '1522')?.textContent || '').includes('vytištěno'),
  );
  check('marking a built book printed writes printed.json and keeps it on the board', existsSync(join(fx.outbox, '1522', 'printed.json')));
  check('marking printed does not write the dispatch marker', !existsSync(join(fx.outbox, '1522', 'sent.json')));

  // 2. A printed book is marked SENT — posted to the customer — and only then leaves the board.
  await page
    .locator('#v-orders.on #ordersBody tr', { has: page.locator('.oid', { hasText: '1525' }) })
    .locator('.act-sent')
    .click();
  await page.waitForFunction(
    () => !Array.from(document.querySelectorAll('#v-orders.on #ordersBody .oid')).some((n) => n.textContent.trim() === '1525'),
  );
  check('marking a printed order sent removes it from the active board', true);
  check('marking sent writes sent.json to the outbox', existsSync(join(fx.outbox, '1525', 'sent.json')));
  check('and never resurrects the retired delivered.json', !existsSync(join(fx.outbox, '1525', 'delivered.json')));

  // --- held orders still surface, but not where this smoke used to look ---
  // The standalone "Potřebuje vás" page is gone: the dashboard's views are home/orders/creatives/
  // calendar/mail/settings/blog, so go('todo') was a no-op and #v-todo.on .item never appeared. Held
  // orders now show as the home "Potřebuje pozornost" KPI and a board chip — assert them there.
  //
  // ⚠ DROPPED WITH THE VIEW: the drafted-email textarea and its copy button. /api/studio still returns
  // `needsYou` carrying that draft, so the data outlived the UI. If the feature moved rather than went,
  // its coverage should move with it — right now nothing tests that David can get the email out.
  await page.evaluate(() => go('orders'));
  await page.waitForSelector('#v-orders.on #ordersBody .oid');
  const heldIds = await page.$$eval('#v-orders.on #ordersBody .oid', (ns) => ns.map((n) => n.textContent.trim()));
  check('a held order surfaces on the board as potřebuje vás', (await badgeIn(heldIds, '1479')) === 'potřebuje vás');
  await page.evaluate(() => go('home'));
  await page.waitForSelector('#v-home.on .kpis .kpi');
  check('the held order is counted on the home KPI strip', (await page.locator('#kpi-held').textContent()).trim() === '1');

  check('no page errors while the board is live', errors.length === 0, errors.join('; '));

  if (shot) {
    await page.evaluate(() => go('home'));
    await page.waitForSelector('#v-home.on .kpis .kpi');
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`\nscreenshot: ${shot}`);
  }

  // --- the Generátor nav opens the review grid (navigates away, so do it last) ---
  await page.evaluate(() => go('home'));
  await page.click('#nav a[data-view="generator"]');
  await page.waitForURL(/\/review$/, { timeout: 5000 }).catch(() => {});
  check('the Generátor nav opens /review', /\/review$/.test(page.url()), page.url());
} finally {
  await browser.close();
  server.close();
  if (keep) console.log(`\nfixture kept at ${fx.root}`);
  else rmSync(fx.root, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
