// The Shopify Chrome extension, driven for real in Brave.
//
// It is not part of this repository — it lives on the Desktop and belongs to the shop — but the
// tool now reads the `objednavka.json` it writes, and that contract is the only place the
// customer's accents survive. Break it and every title page silently loses its diacritics, which
// is the one failure nobody notices until a book is printed.
//
// Brave ships the File System Access API switched off, so this exercises the downloader fallback:
// no folder picker, no user gesture, nothing to click in a native dialog.
//
//   node tools/extensionSmoke.mjs

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import sharp from 'sharp';

const EXTENSION = 'C:/Users/David/Desktop/shopify-fotomalovanky-chrome';
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const ORDER = '1366';
const DEDICATION = 'Pro Jiříčka'; // the whole point: this must reach disk unmangled
const PHOTOS = 4;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail && !ok ? `\n         ${detail}` : ''}`);
  if (!ok) failures++;
};

if (!existsSync(EXTENSION)) {
  console.log(`skipped: no extension at ${EXTENSION}`);
  process.exit(0);
}
if (!existsSync(BRAVE)) {
  console.log(`skipped: no Brave at ${BRAVE}`);
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), 'fma-ext-'));
const downloads = join(root, 'downloads');
const profile = join(root, 'profile');
mkdirSync(downloads, { recursive: true });
mkdirSync(join(profile, 'Default'), { recursive: true });

// chrome.downloads writes to the profile's download directory; there is no launch flag for it.
writeFileSync(
  join(profile, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false }, savefile: { default_directory: downloads } }),
);

const photo = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 120, b: 90 } } }).jpeg().toBuffer();

// The photographs are fetched by the extension's service worker, and Playwright cannot intercept a
// service worker's requests. Serve them for real instead of pretending to.
const photoServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'image/jpeg', 'access-control-allow-origin': '*' });
  res.end(photo);
});
await new Promise((r) => photoServer.listen(0, '127.0.0.1', r));
const photoBase = `http://127.0.0.1:${photoServer.address().port}`;

// Shopify puts the photo URLs and the dedication in one line item's customAttributesV2.
const graphql = {
  data: {
    order: {
      lineItems: {
        nodes: [
          {
            customAttributesV2: [
              ...Array.from({ length: PHOTOS }, (_, i) => ({ type: 'URL', key: `Fotka (${PHOTOS})-${i + 1}`, value: `${photoBase}/photo${i + 1}.jpg?name=photo${i + 1}.jpg` })),
              { type: 'PLAIN', key: 'Věnování', value: DEDICATION },
              { type: 'PLAIN', key: 'Rozvržení', value: 'Galerie' },
            ],
          },
        ],
      },
    },
  },
};

// The current Shopify order page has no <h1> and no #page-title. The only place the order number
// the shop shows ("#1366") survives is the browser tab title — the URL carries a different,
// internal id. Reproduce that exactly, so the order-number reader is tested against the real shape
// and not the layout Shopify has already retired.
const page = `<!doctype html><html><head><title>Fotomalovánky.cz · Orders · #${ORDER} · Shopify</title></head><body>
  <div class="Polaris-Box"><div class="_LineItemGroup_x1y2">line items</div></div>
  <script>
    // The extension hooks window.fetch and reads Shopify's GraphQL reply. Trigger one.
    setTimeout(() => fetch('/admin/internal/web/graphql/core?operationName=OrderFulfillmentOrdersQuery'), 300);
  </script>
</body></html>`;

// Brave is started by hand rather than by launchPersistentContext: Playwright redirects every
// download into its own artifacts folder over the debug protocol, which would defeat the point of
// checking where the files actually land.
const PORT = 9411;
const brave = spawn(BRAVE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=BraveRewards,BraveWallet',
  `--disable-extensions-except=${EXTENSION}`,
  `--load-extension=${EXTENSION}`,
  'about:blank',
], { stdio: 'ignore' });

const endpoint = `http://127.0.0.1:${PORT}`;
for (let i = 0; ; i++) {
  try { await fetch(`${endpoint}/json/version`); break; } catch { if (i > 60) throw new Error('Brave never opened its debug port'); }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.connectOverCDP(endpoint);
const ctx = browser.contexts()[0];
const tab = await ctx.newPage();

// Attaching to a page makes Playwright claim downloads over the debug protocol, which both moves
// them into its artifacts folder and throws away the filename the extension asked for — the
// subfolder and the accents with it. "default" hands downloads back to the profile, whose
// download directory is the temporary folder above.
const cdp = await browser.newBrowserCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
const logs = [];
tab.on('console', (m) => logs.push(m.text()));

// Playwright tries the most recently registered route first, so the catch-all goes on first and
// the specific ones on top of it.
await ctx.route('https://admin.shopify.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: page }));
await ctx.route('**/graphql/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(graphql) }));

await tab.goto(`https://admin.shopify.com/store/aqi8it-7n/orders/${ORDER}`, { waitUntil: 'domcontentloaded' });

const button = tab.locator('#fotomalovanky-download-btn');
await button.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
const stop = async () => { await browser.close().catch(() => {}); brave.kill(); photoServer.close(); };

const appeared = await button.count() === 1;
check('the button appears on an order page', appeared, logs.join('\n         ') || '(the page logged nothing)');
if (!appeared) {
  await stop();
  console.log('\nno button — the rest cannot run');
  process.exit(1);
}
check(`it offers all ${PHOTOS} photographs`, (await button.textContent().catch(() => '') ?? '').includes(String(PHOTOS)), await button.textContent().catch(() => ''));

check('Brave really has the folder picker switched off', await tab.evaluate(() => typeof window.showDirectoryPicker) === 'undefined');

await button.click();

const folder = join(downloads, `Fotomalovanky.cz - Objednávka ${ORDER}`);
const sidecar = join(folder, 'objednavka.json');
for (let i = 0; i < 100 && !existsSync(sidecar); i++) await tab.waitForTimeout(200);

const worker = ctx.serviceWorkers()[0];
const saved = worker ? await worker.evaluate(() => new Promise((r) => chrome.downloads.search({}, (d) => r(d.map((x) => `${x.state} ${x.error ?? ''} ${x.filename}`))))) : [];

check(
  'it saves without a folder picker',
  existsSync(folder),
  `nothing at ${folder}\n         Brave says it downloaded:\n         ${saved.join('\n         ')}\n         ${logs.filter((l) => l.includes('Fotomalovanky')).join('\n         ')}`,
);

const written = existsSync(folder) ? readdirSync(folder) : [];
const jpgs = written.filter((f) => f.endsWith('.jpg'));
check(`all ${PHOTOS} photographs land in the order's folder`, jpgs.length === PHOTOS, `saw ${written.join(', ')}`);
check('the photograph is the photograph, not an error page', jpgs.length > 0 && readFileSync(join(folder, jpgs[0])).subarray(0, 2).toString('hex') === 'ffd8');
check('the file name still carries the dedication', jpgs.some((f) => f.includes('pro jiříčka')), jpgs.join(', '));

check('objednavka.json is written beside the photographs', existsSync(sidecar));
if (existsSync(sidecar)) {
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(sidecar, 'utf8')); } catch (e) { check('objednavka.json is valid JSON', false, e.message); }
  if (parsed) {
    check('objednavka.json is valid JSON', true);
    check('the dedication survives with its accents', parsed.dedication === DEDICATION, `got ${JSON.stringify(parsed.dedication)}`);
    check('it names the order', parsed.order === ORDER, `got ${JSON.stringify(parsed.order)}`);
    check('it lists the photographs it saved', Array.isArray(parsed.photos) && parsed.photos.length === PHOTOS);
  }
}

check('the operator is told it finished', (await button.textContent().catch(() => '') ?? '').toLowerCase().includes('dokončeno'), await button.textContent().catch(() => ''));

await stop();
console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
