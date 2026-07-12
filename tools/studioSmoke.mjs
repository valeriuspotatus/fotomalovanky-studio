// Browser smoke for the studio dashboard's live order board (U8 read path). Not part of
// `npm test` — it needs a real Chromium (`npx playwright install chromium`), and the offline suite
// must stay network- and browser-free.
//
//   node tools/studioSmoke.mjs [--keep] [--shot studio.png]
//
// Builds a throwaway inbox/outbox holding one order in each board state, serves the real dashboard
// against it, and asserts the things only a browser can prove: that Objednávky renders the queue
// oldest-first from /api/studio (no static analytics), that a held order surfaces under Potřebuje
// vás with its draft email and a copy button, that the marketing tabs still render their static
// content, and that the Generátor tile opens /review.

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
 *  optional built PDF and delivery marker — exactly the facts the board derives its status from. */
function seedOrder(root, id, { photos = [], statuses = {}, intake = null, draftEmail = null, pdf = false, delivered = false }) {
  const inboxDir = join(root, 'inbox', id);
  mkdirSync(inboxDir, { recursive: true });
  for (const base of photos) writeFileSync(join(inboxDir, `${base}.jpeg`), 'jpeg-bytes');

  if (Object.keys(statuses).length || intake || pdf || delivered) {
    const outDir = join(root, 'outbox', id);
    mkdirSync(outDir, { recursive: true });
    const m = emptyManifest(id);
    for (const [base, st] of Object.entries(statuses)) setStatus(m, base, st, st);
    if (intake) setIntake(m, intake);
    writeManifest(outDir, m);
    if (draftEmail) writeFileSync(join(outDir, 'draft-email.txt'), draftEmail);
    if (pdf) writeFileSync(join(outDir, `${id} Final.pdf`), '%PDF-1.4\nstub\n');
    if (delivered) writeFileSync(join(outDir, 'delivered.json'), JSON.stringify({ at: 'smoke' }));
  }
}

const DRAFT = 'Komu: babicka@example.cz\nPředmět: Vaše fotky k omalovánkám\n\nDobrý den, chybí nám 1 fotka…';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fma-studio-smoke-'));
  // Deliberately seeded out of order to prove the board sorts oldest-first, not insertion order.
  seedOrder(root, '1600', { photos: ['a'] }); // queued — nothing generated
  seedOrder(root, '1523', { photos: ['a'], statuses: { a: STATES.OK }, pdf: true, delivered: true }); // sent
  seedOrder(root, '1479', {
    photos: ['a', 'b'],
    intake: { verdict: 'hold', override: false, unique: 1, expected: 2, findings: [{ check: 'count', verdict: 'hold' }] },
    draftEmail: DRAFT,
  }); // held -> Potřebuje vás
  seedOrder(root, '1522', { photos: ['a'], statuses: { a: STATES.OK }, pdf: true }); // ready-to-send
  seedOrder(root, '1521', { photos: ['a', 'b'], statuses: { a: STATES.OK, b: STATES.FLAGGED } }); // pending-review
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
  // The KPI strip is live from /api/studio: the fixture has exactly one ready-to-send order (1522).
  await page.waitForFunction(() => document.querySelector('#kpi-ready')?.textContent === '1');

  // --- home is the operational dashboard: a 5-KPI strip bound to the board, not the old analytics ---
  check('the home KPI strip shows the board states', (await page.locator('#v-home.on .kpis .kpi').count()) === 5);
  check('the home KPIs bind live counts (ready-to-send = 1)', (await page.locator('#kpi-ready').textContent()).trim() === '1');
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

  // --- marketing tabs still render their static content (restyled, left functional) ---
  await page.evaluate(() => go('creatives'));
  // <option>s only count as "visible" with the dropdown open, so assert on count, not visibility.
  await page.waitForFunction(() => document.querySelectorAll('#v-creatives.on #cvCampaign option').length >= 3);
  check('Kreativy studio renders its campaign picker from /api/creatives', (await page.locator('#v-creatives.on #cvCampaign option').count()) >= 3);
  check('Kreativy studio mounts a live preview frame', (await page.locator('#v-creatives.on #cvFrame').count()) === 1);
  check(
    'Kreativy studio exposes the AI image generator',
    (await page.locator('#v-creatives.on #cvGenerate').count()) === 1 && (await page.locator('#v-creatives.on #cvPrompt').count()) === 1,
  );
  check('Sdělení tab is gone from the sidebar', (await page.locator('#nav a[data-view="sdeleni"]').count()) === 0);

  // --- Kalendář: the calendar opens on the REAL current month (today is pinned to new Date()) ---
  await page.evaluate(() => go('calendar'));
  await page.waitForSelector('#v-calendar.on #calGridBig .d.clickable');
  const MON_NOM = ['Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen', 'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec'];
  const now = new Date();
  const expectLabel = `${MON_NOM[now.getMonth()]} ${now.getFullYear()}`;
  check('the calendar opens on the real current month', (await page.locator('#calLabelBig').textContent()).trim() === expectLabel);
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
  // 1523 is delivered (sent); the active board hides it and lists the rest oldest-first.
  check('the active board hides sent orders, oldest-first', activeIds.join() === '1479,1521,1522,1600', activeIds.join(' > '));
  check('a built, undelivered order reads ready-to-send', (await badgeIn(activeIds, '1522')) === 'připraveno');
  check('a flagged order reads pending-review', (await badgeIn(activeIds, '1521')) === 'ke kontrole');
  check('an ungenerated order reads queued', (await badgeIn(activeIds, '1600')) === 've frontě');

  // The "show done" toggle counts and reveals the sent orders.
  check('a toggle counts the sent orders', (await page.locator('#doneToggle #toggleDone').textContent()).includes('(1)'));
  await page.locator('#doneToggle #toggleDone').click();
  await page.waitForFunction(() => document.querySelectorAll('#v-orders.on #ordersBody .oid').length === 5);
  const allIds = await page.$$eval('#v-orders.on #ordersBody .oid', (ns) => ns.map((n) => n.textContent.trim()));
  check('revealing done shows the delivered order as sent', (await badgeIn(allIds, '1523')) === 'odesláno');

  check('the board carries no hardcoded order data', !(await page.locator('#v-orders.on #ordersBody').textContent()).includes('218k'));

  // --- mark-as-sent: a ready-to-send order can be marked delivered straight from the board ---
  await page.locator('#doneToggle #toggleDone').click(); // hide done again
  await page.waitForFunction(() => document.querySelectorAll('#v-orders.on #ordersBody .oid').length === 4);
  await page
    .locator('#v-orders.on #ordersBody tr', { has: page.locator('.oid', { hasText: '1522' }) })
    .locator('.act-sent')
    .click();
  await page.waitForFunction(
    () => !Array.from(document.querySelectorAll('#v-orders.on #ordersBody .oid')).some((n) => n.textContent.trim() === '1522'),
  );
  check('marking a ready order sent removes it from the active board', true);
  check('marking sent writes the delivery marker to the outbox', existsSync(join(fx.outbox, '1522', 'delivered.json')));

  // --- Potřebuje vás: the held order with its draft email + copy action ---
  await page.evaluate(() => go('todo'));
  await page.waitForSelector('#v-todo.on .item');
  check('exactly the held order surfaces under Potřebuje vás', (await page.locator('#v-todo.on .item').count()) === 1);
  check('the held card carries its order number', (await page.locator('#v-todo.on .item h3, #v-todo.on .item .k').first().textContent()).includes('1479'));
  const mail = await page.locator('#v-todo.on .item .mail').inputValue();
  check('the drafted Czech email is shown to copy', mail.includes('babicka@example.cz'));

  await page.locator('#v-todo.on .item .copy').click();
  await page.waitForFunction(() => document.querySelector('#v-todo.on .item .copy')?.classList.contains('ok'));
  check('the copy button confirms it copied', (await page.locator('#v-todo.on .item .copy').textContent()).includes('Zkopírováno'));

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
