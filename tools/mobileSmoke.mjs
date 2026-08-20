// Every screen of the studio, on a phone.
//
// The rule this exists to hold: NO SCREEN MAY BE UNREACHABLE AND NO SCREEN MAY GO SIDEWAYS. Under
// 900px the sidebar used to be `display:none`, so a phone could open the dashboard and nothing else
// — and the generator had no viewport meta at all, so it laid out at 980px and shrank. Both are the
// kind of thing that looks fine in a screenshot and cannot be worked in.
//
//   node tools/mobileSmoke.mjs [--keep]

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { createReviewServer } from '../src/ui/server.js';
import { STATES, emptyManifest, setStatus, setSource, writeManifest } from '../src/manifest.js';

const keep = process.argv.includes('--keep');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120"><path d="M0 0 L160 120"/></svg>';
const ORDER = '1801';
const BASE = `${ORDER}_img0001`;

/** The phones and the tablet the operator actually holds, and the desk they sit at. */
const SIZES = [
  { name: 'iPhone 14 (390x844)', width: 390, height: 844, mobile: true },
  { name: 'iPhone 14 Pro Max (430x932)', width: 430, height: 932, mobile: true },
  { name: 'iPad portrait (768x1024)', width: 768, height: 1024, mobile: true },
  { name: 'desktop (1440x900)', width: 1440, height: 900, mobile: false },
];

/** Every destination the sidebar carries. All of them must be reachable from a phone. */
const DESTINATIONS = ['Přehled', 'Objednávky', 'Tisková fronta', 'Generátor', 'Kreativy', 'Blog', 'Pošta'];

const photo = (dest, w = 320, h = 240) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#c8d8e8' } }).jpeg().toFile(dest);
const lineArt = (dest) =>
  sharp({ create: { width: 160, height: 120, channels: 3, background: '#ffffff' } })
    .composite([{ input: { create: { width: 160, height: 16, channels: 3, background: '#000000' } }, top: 50, left: 0 }])
    .png()
    .toFile(dest);

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fma-mobile-'));
  const inbox = join(root, 'inbox');
  const outbox = join(root, 'outbox');
  mkdirSync(join(inbox, ORDER), { recursive: true });
  const source = join(inbox, ORDER, `${BASE}.jpeg`);
  await photo(source, 900, 1200);

  const dir = join(outbox, ORDER);
  mkdirSync(dir, { recursive: true });
  await photo(join(dir, `${BASE}.jpg`));
  await lineArt(join(dir, `${BASE}_bw.png`));
  writeFileSync(join(dir, `${BASE}.svg`), SVG);
  let m = setStatus(emptyManifest(ORDER), BASE, STATES.FLAGGED, 'solid-fill');
  m = setSource(m, BASE, source);
  writeManifest(dir, m);
  return { root, inbox, outbox, dir, source };
}

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push(pass);
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const fx = await fixture();
const config = {
  generator: { baseUrl: 'https://example.test/tok', mode: 'api', variant: '2509_1.5', diffusionSteps: 8 },
  builder: { baseUrl: 'https://example.test', pdf: {} },
  paths: { inbox: fx.inbox, outbox: fx.outbox },
  // What loadConfig would have filled in. Every integration off: this harness is about layout, and
  // a screen that says "not connected" is a screen that still has to fit on the phone.
  creatives: { dataDir: join(fx.root, 'creatives') },
  shopify: { enabled: false, dataDir: join(fx.root, 'shop') },
  mail: { enabled: false },
  ai: { enabled: false },
  retentionDays: 30,
};
const okQc = async () => ({ verdict: 'ok', reason: 'ok' });
const okIntake = async () => ({ verdict: 'ok', findings: [], expected: null, uploaded: 1, unique: 1, emailCase: null });
const generator = { async generate() { throw new Error('the smoke never generates'); } };

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
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();

/** Does the page run off the side? One pixel of slack for sub-pixel layout rounding. */
const spills = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    ? `${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth}`
    : null);

/** Anything drawn wider than the window, named, so a failure says WHICH element. */
const overflowing = (page) =>
  page.evaluate(() => {
    const limit = document.documentElement.clientWidth + 1;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.offsetParent === null && el.tagName !== 'DIALOG') continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > limit + 2) out.push(`${el.tagName}.${(el.className || '').toString().split(' ')[0]} → ${Math.round(r.right)}`);
    }
    return out.slice(0, 4);
  });

/** Is the drawer actually ON SCREEN? Not `isVisible()`: an off-canvas drawer is translated out of
 *  the window, not hidden, so it still has a box and still counts as visible. Its right edge is the
 *  only honest answer. */
const drawerShowing = (page) =>
  page.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().right > 1);

/** …and it slides, so give the transition time to land before believing the answer. */
async function drawerSettles(page, wanted) {
  try {
    await page.waitForFunction(
      (w) => (document.querySelector('.sidebar').getBoundingClientRect().right > 1) === w,
      wanted,
      { timeout: 2000 },
    );
  } catch {
    // fall through — the check below reports what it actually found
  }
  return (await drawerShowing(page)) === wanted;
}

const errors = [];
function watch(page) {
  page.on('pageerror', (e) => errors.push(`uncaught: ${e}`));
  page.on('console', (m) => {
    // 4xx and 503 are answers, not faults: with every integration switched off, "not configured" is
    // what Pošta, Blog and the economics are SUPPOSED to say, and the browser logs each one. A 500
    // still counts, because that is the studio breaking.
    if (m.type() === 'error' && !/(40[0-9]|503) \(/.test(m.text())) errors.push(m.text());
  });
}

try {
  for (const size of SIZES) {
    console.log(`\n${size.name}`);
    const page = await browser.newPage({
      viewport: { width: size.width, height: size.height },
      hasTouch: size.mobile,
      isMobile: size.mobile,
    });
    watch(page);

    // ---- the dashboard ------------------------------------------------------------------------
    await page.goto(`${origin}/`);
    await page.waitForSelector('.app');

    if (size.mobile) {
      check('a top bar with a menu button', await page.locator('.mtop .nav-burger').isVisible());
      check('and the page title in it', (await page.locator('.mtop-title').textContent()).trim().length > 0);
      check('the production tabs are on screen', await page.locator('.mbot').isVisible());
      check('the desktop sidebar is out of the way', await drawerSettles(page, false));

      // The drawer, and everything in it.
      await page.click('.mtop .nav-burger');
      await page.waitForSelector('.app.nav-open');
      check('the menu button opens a drawer', await drawerSettles(page, true));
      const drawer = await page.locator('.sidebar').textContent();
      const missing = DESTINATIONS.filter((d) => !drawer.includes(d));
      check('EVERY destination is in the drawer', missing.length === 0, missing.join(', '));
      check('and the drawer keeps Nastavení and Můj profil reachable', /Nastavení/.test(drawer));
      check('nothing behind it can be tabbed into', await page.evaluate(() => document.querySelector('.main').inert === true));

      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.app').classList.contains('nav-open'));
      check('Escape closes it', await drawerSettles(page, false));

      // Navigating from the drawer closes it — a drawer still covering the page reads as a dead tap.
      await page.click('.mtop .nav-burger');
      await page.waitForSelector('.app.nav-open');
      await page.click('.sidebar .nav a[data-view="queue"]');
      await page.waitForFunction(() => !document.querySelector('.app').classList.contains('nav-open'));
      check('choosing a screen closes the drawer', await drawerSettles(page, false));
      check('and the screen actually changed', (await page.evaluate(() => location.hash)) === '#queue');
      check('the tab bar follows', await page.locator('.mbot [data-tab="queue"].on').isVisible());
    } else {
      check('the sidebar is the navigation', await page.locator('.sidebar').isVisible());
      check('no phone chrome on a desktop', !(await page.locator('.mtop').isVisible()) && !(await page.locator('.mbot').isVisible()));
      check('the page title is still on the page', await page.locator('.topbar h1').isVisible());
    }

    // ---- every dashboard screen, checked for spill ---------------------------------------------
    const spilled = [];
    for (const view of ['home', 'orders', 'queue', 'creatives', 'blog', 'mail', 'settings', 'profile']) {
      await page.evaluate((v) => { location.hash = v; }, view);
      await page.waitForTimeout(220);
      const bad = await spills(page);
      if (bad) spilled.push(`${view} (${bad}) ${(await overflowing(page)).join('; ')}`);
    }
    check('no dashboard screen runs off the side', spilled.length === 0, spilled.join(' | '));

    // ---- the generator ------------------------------------------------------------------------
    await page.goto(`${origin}/review`);
    await page.waitForSelector('.tile');
    check('the generator opens and shows its cards', (await page.locator('.tile').count()) === 1);
    check('the generator does not run off the side', (await spills(page)) === null, `${await spills(page)} ${(await overflowing(page)).join('; ')}`);

    if (size.mobile) {
      check('it has the same navigation as everything else', await page.locator('.mbot').isVisible());
      check('and knows it is the generator', await page.locator('.mbot [data-tab="generator"].on').isVisible());
      // The photo above the coloring page: side by side on a phone is two pictures nobody can judge.
      const stacked = await page.evaluate(() => {
        const f = document.querySelectorAll('.tile .imgs figure');
        if (f.length < 2) return null;
        return f[1].getBoundingClientRect().top >= f[0].getBoundingClientRect().bottom - 2;
      });
      check('the pair stacks: original above generated', stacked !== false);
      const tap = await page.evaluate(() => {
        const b = [...document.querySelectorAll('.tile .acts button')];
        return b.length ? Math.min(...b.map((x) => x.getBoundingClientRect().height)) : 0;
      });
      check('the card actions are big enough to hit', tap >= 34, `${Math.round(tap)}px`);
    }

    // The crop editor is the reason the generator has to work from a phone at all.
    await page.locator('.tile .acts button[data-crop]').click();
    await page.waitForSelector('#pc[open]');
    await page.waitForFunction(() => document.querySelector('#pc-base')?.width > 0);
    const fits = await page.evaluate(() => {
      const r = document.querySelector('#pc').getBoundingClientRect();
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        vw: document.documentElement.clientWidth,
        vh: document.documentElement.clientHeight,
      };
    });
    check('the crop editor fits inside the window', fits.w <= fits.vw + 1 && fits.h <= fits.vh + 1, JSON.stringify(fits));
    check('with the picture and its controls all on screen',
      await page.locator('#pc .pcstage').isVisible() && await page.locator('#pc-save').isVisible());
    check('and the dialog itself does not spill', (await spills(page)) === null);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#pc').open);

    await page.close();
  }

  console.log('');
  check('no uncaught page errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));
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
