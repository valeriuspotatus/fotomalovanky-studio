import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { createReviewServer, openCommand, powershellPath, openExternally, pickFolder, pickFolderScript, ROUTE_POLICY } from '../src/ui/server.js';
import { hashPassword, ROLE_ENV_VARS } from '../src/auth/credentials.js';
import { LOGIN_PAGE_PATH, SIGN_IN_PATH, SIGN_OUT_PATH } from '../src/auth/sessions.js';
import { STATES, readManifest, getStatus, setStatus, setIntake, writeManifest, emptyManifest } from '../src/manifest.js';
import { writeReport } from '../src/autopilotReport.js';

const TOKEN = 'sup3r-s3cret-t0ken-abc123';
const CONFIG = {
  generator: { baseUrl: `https://fotomalovanky-app.onrender.com/${TOKEN}/`, mode: 'api', variant: '2509_1.5', diffusionSteps: 8 },
  builder: { baseUrl: 'https://example.test/builder' },
  paths: { inbox: './inbox', outbox: './outbox' },
};
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10"/></svg>';

/** A stand-in coloring raster: 1px lines with white paper between them. Half ink, but nothing
 *  filled — a solid black block would trip qc's solid-fill tripwire, and rightly so. */
const LINE_ART = Buffer.alloc(8 * 8, 255);
for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) LINE_ART[y * 8 + x] = 0;
const RAW_8 = { raw: { width: 8, height: 8, channels: 1 } };

let root, inbox, outbox, orderDir, server, origin;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'fma-srv-'));
  inbox = join(root, 'inbox');
  outbox = join(root, 'outbox');
  orderDir = join(outbox, '1510');
  mkdirSync(join(inbox, '1510'), { recursive: true });
  mkdirSync(orderDir, { recursive: true });

  for (const base of ['clean', 'bad', 'manual']) {
    writeFileSync(join(inbox, '1510', `${base}.jpeg`), 'photo');
    writeFileSync(join(orderDir, `${base}.jpg`), 'jpeg-bytes');
    writeFileSync(join(orderDir, `${base}.svg`), SVG);
    await sharp(LINE_ART, RAW_8).png().toFile(join(orderDir, `${base}_bw.png`));
  }

  const m = emptyManifest('1510');
  setStatus(m, 'clean', STATES.OK, 'ok');
  setStatus(m, 'bad', STATES.FLAGGED, 'near-blank');
  setStatus(m, 'manual', STATES.FLAGGED);
  setStatus(m, 'manual', STATES.MANUAL_IN_PROGRESS);
  writeManifest(orderDir, m);

  ({ server } = createReviewServer({ config: CONFIG, inboxRoot: inbox, outboxRoot: outbox, memoryRoot: outbox, driver: { generate: async () => {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

const get = (p) => fetch(`${origin}${p}`);
const post = (p) => fetch(`${origin}${p}`, { method: 'POST' });

test('home serves the studio dashboard; the review grid moves to /review', async () => {
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  const homeHtml = await home.text();
  assert.match(homeHtml, /Fotomalovánky · Studio|id="homeTiles"/, 'home is the dashboard, not the grid');

  const review = await get('/review');
  assert.equal(review.status, 200);
  assert.match(review.headers.get('content-type'), /text\/html/);
  const reviewHtml = await review.text();
  assert.match(reviewHtml, /id="inbox"|id="run"/, 'the review grid is served at /review');
  assert.ok(!reviewHtml.includes('id="homeTiles"'), 'the grid is not the dashboard');
});

test('a dashboard asset under static/ is served, with its content type', async () => {
  const res = await get('/creatives/graphics/christmas.svg');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await res.text(), /<svg/);
});

test('a path outside static/ is a 404, never a way to reach a secret or source file', async () => {
  // %2e%2e%2f survives URL parsing as ../, then resolves outside static/ and is refused.
  const escape = await get('/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json');
  assert.equal(escape.status, 404);
  assert.ok(!(await escape.text()).includes('fotomalovanky-automation'), 'no file content leaked');

  assert.equal((await get('/does-not-exist.svg')).status, 404);
});

test('the state endpoint reports each photo with its status and reason', async () => {
  const { orders } = await (await get('/api/state')).json();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderId, '1510');

  const byBase = Object.fromEntries(orders[0].photos.map((p) => [p.base, p]));
  assert.equal(byBase.clean.status, STATES.OK);
  assert.equal(byBase.clean.builderEligible, true);
  assert.equal(byBase.bad.status, STATES.FLAGGED);
  assert.equal(byBase.bad.reason, 'near-blank');
  assert.equal(byBase.bad.builderEligible, false);
  assert.equal(byBase.manual.status, STATES.MANUAL_IN_PROGRESS);
  assert.equal(orders[0].summary.ready, false);
});

test('the generator token never crosses to the page', async () => {
  const body = await (await get('/api/state')).text();
  assert.ok(!body.includes(TOKEN), 'the token is the only credential the generator has');
  assert.ok(!body.includes('onrender.com'));
  const html = await (await get('/')).text();
  assert.ok(!html.includes(TOKEN));
});

test('the studio board reports the order derived status, counts, and an empty needs-you', async () => {
  const res = await get('/api/studio');
  assert.equal(res.status, 200);
  const board = await res.json();
  assert.equal(board.orders.length, 1);
  assert.equal(board.orders[0].orderId, '1510');
  // clean=ok, bad=flagged, manual=in-progress: a photo still awaits the operator, so pending-review
  // — not needs-you, which is intake holds only.
  assert.equal(board.orders[0].status, 'pending-review');
  assert.equal(board.counts.total, 1);
  assert.equal(board.counts['pending-review'], 1);
  assert.deepEqual(board.needsYou, []);
  assert.equal(board.run.active, false);
  assert.equal(board.run.orderId, null);
});

test('the studio board never leaks the generator token either', async () => {
  assert.ok(!(await (await get('/api/studio')).text()).includes(TOKEN));
});

test('the studio board carries the overnight rollup when a night report is present; none crosses no secret', async () => {
  const r = mkdtempSync(join(tmpdir(), 'fma-overnight-'));
  const data = join(r, 'data');
  // A report older than the poll interval — the server always returns it (staleness is the client's
  // tell that the machine slept); it must still surface, not be dropped.
  writeReport(data, {
    ranAt: '2026-07-11T02:12:00.000Z',
    counts: { ready: 4, held: 1, failed: 0 },
    processed: 5,
    estSpend: 1.5,
    orders: [{ orderId: '1600', status: 'ready' }],
  });
  const config = { ...CONFIG, shopify: { dataDir: data } };
  const { server: s } = createReviewServer({ config, inboxRoot: inbox, outboxRoot: outbox, memoryRoot: outbox });
  await new Promise((done) => s.listen(0, '127.0.0.1', done));
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/studio`);
    const text = await res.text();
    assert.ok(!text.includes(TOKEN), 'the report read must never carry a secret to the page');
    const board = JSON.parse(text);
    assert.equal(board.overnight.orders.ready, 4);
    assert.equal(board.overnight.orders.held, 1);
    assert.equal(board.overnight.count, 5);
    assert.equal(board.overnight.estSpend, 1.5);
    assert.equal(board.overnight.ranAt, '2026-07-11T02:12:00.000Z', 'a stale run is still surfaced');
  } finally {
    s.close();
    rmSync(r, { recursive: true, force: true });
  }
});

test('with no night report the board simply carries no overnight block (manual-only day)', async () => {
  const board = await (await get('/api/studio')).json();
  assert.equal(board.overnight, null, 'the base server config has no shopify.dataDir, so no rollup');
});

test('an intake-held order surfaces under needs-you on the board, with its drafted email', async () => {
  const r = mkdtempSync(join(tmpdir(), 'fma-held-'));
  const inb = join(r, 'inbox');
  const outb = join(r, 'outbox');
  const dir = join(outb, '1479');
  mkdirSync(join(inb, '1479'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(inb, '1479', 'a.jpeg'), 'photo');
  writeFileSync(join(inb, '1479', 'b.jpeg'), 'photo');

  // The intake gate held it: a stored hold verdict and a copy-paste email beside the order — the
  // exact shape runPipeline leaves behind, minus a running server.
  const m = emptyManifest('1479');
  setIntake(m, { verdict: 'hold', override: false, expected: 8, uploaded: 5, unique: 5, findings: [{ check: 'count', verdict: 'hold' }] });
  writeManifest(dir, m);
  const draft = 'Komu: babicka@example.cz\nPředmět: Vaše fotky\n\nDobrý den, chybí nám 3 fotky…\n';
  writeFileSync(join(dir, 'draft-email.txt'), draft);

  const { server: s } = createReviewServer({ config: CONFIG, inboxRoot: inb, outboxRoot: outb, memoryRoot: outb });
  await new Promise((done) => s.listen(0, '127.0.0.1', done));
  try {
    const board = await (await fetch(`http://127.0.0.1:${s.address().port}/api/studio`)).json();
    assert.equal(board.orders[0].status, 'held');
    assert.equal(board.counts.held, 1);
    assert.equal(board.needsYou.length, 1);
    assert.equal(board.needsYou[0].orderId, '1479');
    assert.match(board.needsYou[0].draftEmail, /babicka@example\.cz/);
    assert.match(board.needsYou[0].reason, /5 z 8/, 'the why-line reads off the stored intake block');
  } finally {
    s.close();
    rmSync(r, { recursive: true, force: true });
  }
});

test('photo files are addressed by (order, base, kind), never by path', async () => {
  const { orders } = await (await get('/api/state')).json();
  const payload = JSON.stringify(orders[0].photos);
  assert.ok(!payload.includes('.png'), 'no file paths in the photo payload');
  assert.ok(!payload.includes('.svg'));

  const res = await get('/img/1510/bad/coloring');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  // A completed redo must not be masked by a cached render of the version just rejected.
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('a crafted image path is refused, not walked', async () => {
  for (const p of ['/img/1510/..%2F..%2F..%2Fetc%2Fpasswd/coloring', '/img/..%2F..%2Fsecrets/x/original', '/img/1510/nope/coloring']) {
    const res = await get(p);
    assert.equal(res.status, 409, p);
    assert.match((await res.json()).error, /Unknown/);
  }
});

test('approving a flagged photo writes state.json and clears the review gate', async () => {
  const res = await post('/api/1510/bad/approve');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, STATES.APPROVED);
  assert.equal(getStatus(readManifest(orderDir), 'bad'), STATES.APPROVED);

  const { orders } = await (await get('/api/state')).json();
  assert.ok(orders[0].photos.find((p) => p.base === 'bad').builderEligible);
});

test('approving a photo that is out for manual repair is refused with the operator-facing reason', async () => {
  const res = await post('/api/1510/manual/approve');
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /out for manual repair/);
  assert.equal(getStatus(readManifest(orderDir), 'manual'), STATES.MANUAL_IN_PROGRESS);
});

test('an unknown action or photo is a clean 4xx, not a crash', async () => {
  assert.equal((await post('/api/1510/clean/detonate')).status, 404);
  assert.equal((await post('/api/1510/ghost/approve')).status, 409);
  assert.equal((await post('/api/9999/clean/approve')).status, 409);
});

test('the title-page text is saved on the order and reported back', async () => {
  const res = await fetch(`${origin}/api/1510/dedication`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '  Pro Barču, s láskou  ' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).dedication, 'Pro Barču, s láskou');
  assert.equal(readManifest(orderDir).dedication, 'Pro Barču, s láskou');

  const { orders } = await (await get('/api/state')).json();
  assert.equal(orders[0].dedication, 'Pro Barču, s láskou');
});

test('a malformed or oversized dedication body is refused, not stored', async () => {
  const bad = await fetch(`${origin}/api/1510/dedication`, { method: 'POST', body: 'not json' });
  assert.equal(bad.status, 409);
  assert.match((await bad.json()).error, /not valid JSON/);

  const unknown = await fetch(`${origin}/api/9999/dedication`, {
    method: 'POST',
    body: JSON.stringify({ text: 'x' }),
  });
  assert.equal(unknown.status, 409);

  // The earlier value survived both refusals.
  assert.equal(readManifest(orderDir).dedication, 'Pro Barču, s láskou');
});

test('an over-long dedication is capped rather than rejected', async () => {
  const res = await fetch(`${origin}/api/1510/dedication`, {
    method: 'POST',
    body: JSON.stringify({ text: 'x'.repeat(900) }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).dedication.length, 500);
});

test('marking a clean photo bad pulls it back out of the builder gate', async () => {
  assert.equal((await (await post('/api/1510/clean/reject')).json()).status, STATES.FLAGGED);
  const { orders } = await (await get('/api/state')).json();
  assert.equal(orders[0].photos.find((p) => p.base === 'clean').builderEligible, false);
  assert.equal(orders[0].summary.ready, false);
});

// ---- opening things on the desktop ------------------------------------------
// PATH is capped near 2047 chars on Windows and silently loses its tail. On the operator's
// machine System32 had fallen off it, so a bare "cmd" resolved to nothing, spawn raised ENOENT
// on an async 'error' event, and the unhandled event killed the server as it started.

test('on Windows the desktop is opened through an absolute cmd.exe, never a bare "cmd"', () => {
  const [bin, args] = openCommand('http://127.0.0.1:4173/', 'win32', { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' });
  assert.equal(bin, 'C:\\WINDOWS\\system32\\cmd.exe');
  assert.deepEqual(args, ['/c', 'start', '', 'http://127.0.0.1:4173/']);
});

test('a relative/forward-slashed folder target is resolved absolute for cmd start', () => {
  // Regression: revealing the finished folder passed config's "./outbox" straight to `start`, and
  // Explorer failed with `cannot find …\.\outbox`. A path must be absolute + native-separator; a URL
  // must be left exactly as-is.
  const [, args] = openCommand('./outbox', 'win32', { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' });
  const opened = args[3];
  assert.equal(opened, resolve('./outbox'), 'the relative path is resolved to an absolute one');
  assert.ok(!opened.includes('/'), 'no forward slashes survive into the Windows target');
  assert.ok(!/[\\/]\.[\\/]/.test(opened), 'the "./" segment is collapsed');
  const [, urlArgs] = openCommand('file:///C:/x', 'win32', { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' });
  assert.equal(urlArgs[3], 'file:///C:/x', 'a URL target is passed through untouched');
});

test('without ComSpec it is still absolute, derived from SystemRoot', () => {
  const [bin] = openCommand('x', 'win32', { SystemRoot: 'D:\\Windows' });
  assert.equal(bin, join('D:\\Windows', 'System32', 'cmd.exe'));
  const [fallback] = openCommand('x', 'win32', {});
  assert.match(fallback, /System32[\\/]cmd\.exe$/);
  assert.notEqual(fallback, 'cmd');
});

test('the folder picker resolves PowerShell absolutely too', () => {
  assert.equal(
    powershellPath({ SystemRoot: 'D:\\Windows' }),
    join('D:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  );
});

test('macOS and Linux keep their PATH-resolved openers', () => {
  assert.deepEqual(openCommand('x', 'darwin', {}), ['open', ['x']]);
  assert.deepEqual(openCommand('x', 'linux', {}), ['xdg-open', ['x']]);
});

test('a browser that cannot be launched resolves false instead of killing the tool', async () => {
  // spawn reports a missing binary on an asynchronous 'error' event. If nothing listens for it,
  // Node treats it as an unhandled error and tears the process down — which is exactly how the
  // server died at startup. If that regressed, this test would not fail; it would crash the run.
  assert.equal(await openExternally('http://127.0.0.1:4173/', ['C:\\NoSuchDir\\nope.exe', []]), false);
});

// The grid can only prefill a title page it is actually sent. `reviewState` derived it, but the
// field was dropped on the way through `forClient`, so the browser never saw it.
test('the title-page text derived from the photo names reaches the browser', async () => {
  const r = mkdtempSync(join(tmpdir(), 'fma-suggest-'));
  const outb = join(r, 'outbox');
  const dir = join(outb, '1521');
  mkdirSync(dir, { recursive: true });
  const base = '1521_img0001_-_pro_maxinnku_a_estellku';
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toFile(join(dir, `${base}.jpg`));
  writeManifest(dir, setStatus(emptyManifest('1521'), base, STATES.OK, 'ok'));

  const { server: s } = createReviewServer({ config: CONFIG, inboxRoot: join(r, 'inbox'), outboxRoot: outb, memoryRoot: outb });
  await new Promise((done) => s.listen(0, '127.0.0.1', done));
  try {
    const { orders } = await (await fetch(`http://127.0.0.1:${s.address().port}/api/state`)).json();
    assert.equal(orders[0].dedication, '', 'nobody has decided it yet');
    assert.equal(orders[0].suggestedDedication, 'Pro Maxinnku a Estellku');
  } finally {
    s.close();
    rmSync(r, { recursive: true, force: true });
  }
});

// ---- the folder dialog ------------------------------------------------------

test('the picker script shows a real owner window and forces itself forward', () => {
  const s = pickFolderScript('');
  // An unshown TopMost form is on top of nothing; the dialog it owns opens behind the browser.
  assert.match(s, /\$owner\.Show\(\)/);
  // Windows refuses the foreground to a process that got no click. Borrow the input queue.
  assert.match(s, /AttachThreadInput/);
  assert.match(s, /SetForegroundWindow/);
  assert.match(s, /FolderBrowserDialog/);
});

test("the picker opens where the operator left off, and a quote in the path cannot break out", () => {
  assert.match(pickFolderScript('C:\Orders'), /\$d\.SelectedPath = 'C:\Orders'/);
  // PowerShell escapes a single quote by doubling it; anything else ends the string early and
  // the rest of the operator's folder name becomes code.
  assert.match(pickFolderScript("C:\it's here"), /'C:\it''s here'/);
  assert.doesNotMatch(pickFolderScript(''), /\$d\.SelectedPath =/);
});

test('there is no folder dialog off Windows, and asking for one is not an error', async () => {
  assert.deepEqual(await pickFolder('', 'darwin'), { path: null, available: false });
  assert.deepEqual(await pickFolder('', 'linux'), { path: null, available: false });
});

// ---- choosing which orders to work on ---------------------------------------

async function pickServer() {
  const r = mkdtempSync(join(tmpdir(), 'fma-pick-'));
  const inb = join(r, 'inbox');
  const outb = join(r, 'outbox');
  for (const id of ['1510', '1523', '1479']) {
    mkdirSync(join(inb, id), { recursive: true });
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toFile(join(inb, id, `${id}_img0001.jpeg`));
  }
  // An order that exists only in the outbox: finished earlier, photos long since purged.
  mkdirSync(join(outb, '1400'), { recursive: true });
  writeManifest(join(outb, '1400'), setStatus(emptyManifest('1400'), 'old', STATES.OK, 'ok'));

  const { server: s } = createReviewServer({ config: CONFIG, inboxRoot: inb, outboxRoot: outb, memoryRoot: outb });
  await new Promise((done) => s.listen(0, '127.0.0.1', done));
  const o = `http://127.0.0.1:${s.address().port}`;
  const post = (p, body) => fetch(o + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const state = async () => (await fetch(`${o}/api/state`)).json();
  return { inb, outb, post, state, cleanup: () => { s.close(); rmSync(r, { recursive: true, force: true }); } };
}

test('scanning a folder lists its orders, spends nothing, and ticks a handful', async () => {
  const f = await pickServer();
  try {
    const body = await (await f.post('/api/_scan', { path: f.inb })).json();
    assert.deepEqual(body.orders.map((o) => o.orderId).sort(), ['1479', '1510', '1523']);
    assert.equal(body.orders[0].photos, 1);
    assert.deepEqual(body.selected.sort(), ['1479', '1510', '1523'], 'three is a handful, so tick them');

    const { run } = await f.state();
    assert.equal(run.active, false, 'a scan starts nothing');
  } finally {
    f.cleanup();
  }
});

test('a scan of a folder that is not there is a plain refusal, not a crash', async () => {
  const f = await pickServer();
  try {
    const res = await f.post('/api/_scan', { path: join(f.inb, 'nope') });
    assert.equal(res.status, 409);
    assert.ok((await res.json()).error);
  } finally {
    f.cleanup();
  }
});

test('the grid shows only the ticked orders, and keeps the earlier ones apart', async () => {
  const f = await pickServer();
  try {
    await f.post('/api/_scan', { path: f.inb });
    await f.post('/api/_select', { orders: ['1510'] });

    const { orders, selected } = await f.state();
    assert.deepEqual(selected, ['1510']);
    const here = orders.filter((o) => o.inInbox).map((o) => o.orderId);
    const earlier = orders.filter((o) => !o.inInbox).map((o) => o.orderId);
    assert.deepEqual(here, ['1510'], 'the unticked orders are not in the grid');
    assert.deepEqual(earlier, ['1400'], 'a finished order is still reviewable, just set apart');
  } finally {
    f.cleanup();
  }
});

test('pressing Go with nothing ticked is refused, not silently a no-op', async () => {
  const f = await pickServer();
  try {
    await f.post('/api/_scan', { path: f.inb });
    await f.post('/api/_select', { orders: [] });
    const res = await f.post('/api/_run', {});
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /[Tt]ick at least one order/);
  } finally {
    f.cleanup();
  }
});

test('a folder holding an archive of orders arrives ticked by nobody', async () => {
  const r = mkdtempSync(join(tmpdir(), 'fma-archive-'));
  const inb = join(r, 'inbox');
  // Nine is past the handful the operator meant to pick. Ticking them all would regenerate
  // every order they have ever shipped.
  for (let i = 0; i < 9; i++) {
    mkdirSync(join(inb, `15${10 + i}`), { recursive: true });
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .jpeg()
      .toFile(join(inb, `15${10 + i}`, 'a.jpeg'));
  }
  const { server: s } = createReviewServer({ config: CONFIG, inboxRoot: inb, outboxRoot: join(r, 'outbox'), memoryRoot: join(r, 'outbox') });
  await new Promise((done) => s.listen(0, '127.0.0.1', done));
  try {
    const origin2 = `http://127.0.0.1:${s.address().port}`;
    const body = await (
      await fetch(`${origin2}/api/_scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: inb }),
      })
    ).json();
    assert.equal(body.orders.length, 9);
    assert.deepEqual(body.selected, [], 'nine orders is an archive opened by mistake');
  } finally {
    s.close();
    rmSync(r, { recursive: true, force: true });
  }
});

// --- GET /api/<order>/zip -------------------------------------------------------------------
// The outbox lives on the server when the tool is hosted, so this route is the only way to get an
// order's files back off it. Entry names are read straight out of the ZIP local file headers, which
// store them uncompressed — enough to prove the archive holds the right files without a zip reader.
const zipNames = (buf) => {
  const names = [];
  for (let i = 0; i + 30 < buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue; // "PK\x03\x04", a local file header
    const nameLen = buf.readUInt16LE(i + 26);
    names.push(buf.subarray(i + 30, i + 30 + nameLen).toString('utf8'));
  }
  return names;
};

test('an order downloads as one zip holding every original and its vector svg', async () => {
  const res = await get('/api/1510/zip');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="1510\.zip"/);

  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'the body is a real zip, not an error page');
  const names = zipNames(buf);
  for (const base of ['clean', 'bad', 'manual']) {
    assert.ok(names.includes(`${base}.jpg`), `${base}.jpg is in the archive`);
    assert.ok(names.includes(`${base}.svg`), `${base}.svg is in the archive`);
  }
  assert.ok(!names.some((n) => n.endsWith('.pdf')), 'no book on disk yet, so no pdf in the archive');
});

test('once the book is built the zip carries it too, under the name the operator knows', async () => {
  const pdf = join(orderDir, '1510 Final.pdf');
  writeFileSync(pdf, '%PDF-1.4\nstub\n');
  try {
    const names = zipNames(Buffer.from(await (await get('/api/1510/zip')).arrayBuffer()));
    assert.ok(names.includes('1510 Final.pdf'), 'the built book ships inside the archive');
    assert.equal(names.filter((n) => n.endsWith('.pdf')).length, 1, 'exactly one pdf, not a duplicate');
  } finally {
    rmSync(pdf, { force: true }); // the order's derived status is shared with the tests above
  }
});

test('a zip for an unknown order is a clean 404, not a truncated archive', async () => {
  const res = await get('/api/9999/zip');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'Unknown order.');
});

// --- GET /api/<order>/pdf -------------------------------------------------------------------
// The finished book, served inline so the operator can look at it before recording it as gone out.
// Addressed by order id like /zip above, so no path from the page reaches the filesystem.

test('GET /api/<order>/pdf serves the built book inline, and 404s before it exists', async () => {
  assert.equal((await get('/api/1510/pdf')).status, 404, 'no book on disk yet');

  const pdf = join(orderDir, '1510 Final.pdf');
  writeFileSync(pdf, '%PDF-1.4\n');
  try {
    const r = await get('/api/1510/pdf');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /application\/pdf/);
    assert.match(await r.text(), /^%PDF/);
  } finally {
    rmSync(pdf, { force: true }); // the order's derived status is shared with the tests above
  }
});

// --- POST /api/<order>/delete ---------------------------------------------------------------
// Deleting writes a permanent marker into the shared fixture's order, which would change what every
// other test in this file sees on the board. So it gets its own server over its own temp outbox.

test('POST /api/<order>/delete hides the order from the board (marker on disk, files kept)', async () => {
  const r = mkdtempSync(join(tmpdir(), 'fma-del-'));
  const inb = join(r, 'inbox');
  const outb = join(r, 'outbox');
  const dir = join(outb, '1510');
  mkdirSync(join(inb, '1510'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(inb, '1510', 'a.jpeg'), 'photo');
  writeFileSync(join(dir, '1510 Final.pdf'), '%PDF-1.4\n');

  const { server: s } = createReviewServer({ config: CONFIG, inboxRoot: inb, outboxRoot: outb, memoryRoot: outb });
  await new Promise((done) => s.listen(0, '127.0.0.1', done));
  const o = `http://127.0.0.1:${s.address().port}`;
  try {
    let board = await (await fetch(`${o}/api/studio`)).json();
    assert.ok(board.orders.some((x) => x.orderId === '1510'), 'on the board before delete');

    const res = await fetch(`${o}/api/1510/delete`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).deleted, '1510');

    board = await (await fetch(`${o}/api/studio`)).json();
    assert.ok(!board.orders.some((x) => x.orderId === '1510'), 'gone from the board after delete');
    assert.ok(existsSync(join(dir, 'hidden.json')), 'a recoverable hidden marker was written');
    assert.ok(existsSync(join(dir, '1510 Final.pdf')), 'the book file is kept, not deleted');
  } finally {
    s.close();
    rmSync(r, { recursive: true, force: true });
  }
});

// --- WHO MAY REACH WHAT (R8, U6) -------------------------------------------------------------
//
// The rule is an ALLOWLIST and these tests are what keeps it one. Jirka's session is a real session
// minted through the real sign-in, not a fabricated identity, so what is asserted here is what a
// browser holding his cookie would actually get.
//
// The last test in this file is the one that matters most in a year's time: it reads the dispatcher's
// own source and fails when a route exists there with no line in ROUTE_POLICY. A deny-list is what
// let the mail, blog-publish and AI-spend routes be reachable in the first draft — every one of them
// added AFTER the rule was written. This is the thing that makes that impossible to repeat quietly.

/** A real scrypt hash at a cheap cost — the stored string is self-describing, so it verifies through
 *  the production path. credentials.test.js is where the production parameters are exercised. */
const cheapHash = (password) => hashPassword(password, { logN: 14, r: 8, p: 1 });
const PASSWORD = 'correct horse battery staple';

/** A gated studio over its own fixture, plus a signed-in cookie for each person. */
async function roleServer() {
  const r = mkdtempSync(join(tmpdir(), 'fma-role-'));
  const inb = join(r, 'inbox');
  const outb = join(r, 'outbox');
  const dir = join(outb, '1510');
  mkdirSync(join(inb, '1510'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(inb, '1510', 'clean.jpeg'), 'photo');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toFile(join(dir, 'clean.jpg'));
  writeFileSync(join(dir, 'clean.svg'), SVG);
  await sharp(LINE_ART, RAW_8).png().toFile(join(dir, 'clean_bw.png'));
  writeFileSync(join(dir, '1510 Final.pdf'), '%PDF-1.4\n');
  writeManifest(dir, setStatus(emptyManifest('1510'), 'clean', STATES.OK, 'ok'));

  const hash = await cheapHash(PASSWORD);
  const { server: s } = createReviewServer({
    config: { ...CONFIG, accounts: { dataDir: join(r, 'accounts') } },
    inboxRoot: inb,
    outboxRoot: outb,
    memoryRoot: outb,
    driver: { generate: async () => {} },
    authEnv: { [ROLE_ENV_VARS.operator]: hash, [ROLE_ENV_VARS.printer]: hash },
  });
  await new Promise((done) => s.listen(0, '127.0.0.1', done));
  const o = `http://127.0.0.1:${s.address().port}`;

  const signIn = async (username) => {
    const res = await fetch(`${o}${SIGN_IN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    assert.equal(res.status, 200, `${username} signs in`);
    return String(res.headers.get('set-cookie')).split(';')[0];
  };

  return {
    origin: o,
    dir,
    operator: await signIn('David'),
    printer: await signIn('Jirka'),
    get: (p, cookie) => fetch(o + p, { headers: { cookie } }),
    post: (p, cookie, body) =>
      fetch(o + p, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
    cleanup: () => { s.close(); rmSync(r, { recursive: true, force: true }); },
  };
}

test('AE5 — settings is refused for the printer and served for the operator', async () => {
  const f = await roleServer();
  try {
    const refused = await f.get('/api/settings', f.printer);
    assert.equal(refused.status, 403, 'Jirka cannot read the settings screen');
    assert.equal((await refused.json()).code, 'forbidden', 'and is told why, in a code the page can act on');

    const allowed = await f.get('/api/settings', f.operator);
    assert.equal(allowed.status, 200, 'David can');
    assert.ok((await allowed.json()).integrations, 'and gets the real payload');
  } finally {
    f.cleanup();
  }
});

test('the printer is refused every route that spends money, writes to a customer, or touches the box', async () => {
  const f = await roleServer();
  try {
    // GETs.
    for (const path of [
      '/api/settings', '/api/mail', '/api/mail/message?uid=1', '/api/mail/templates',
      '/api/blog/topics', '/api/blog/posts', '/api/blog/blogs',
      '/api/creatives/calendar', '/api/studio/templates', '/api/studio/validate', '/studio/preview', '/studio/render',
      '/api/autopilot/status', '/creatives/ad/12-24-vanoce/x.png',
    ]) {
      const res = await f.get(path, f.printer);
      assert.equal(res.status, 403, `GET ${path} is refused for the printer`);
    }

    // POSTs. /api/_shutdown is deliberately only ever exercised as the REFUSED case — the allowed
    // case would stop the process running this suite.
    for (const path of [
      '/api/_scan', '/api/_pick-folder', '/api/_shutdown', '/api/_open/generator', '/api/_open/folder/1510',
      '/api/mail/send', '/api/mail/delete', '/api/mail/flag',
      '/api/blog/draft', '/api/blog/posts', '/api/blog/publish',
      '/api/creative/ai-image', '/api/autopilot/run',
      '/api/1510/delete', '/api/1510/sent', '/api/1510/unsent', '/api/1510/emailed',
    ]) {
      const res = await f.post(path, f.printer, {});
      assert.equal(res.status, 403, `POST ${path} is refused for the printer`);
      assert.equal((await res.json()).code, 'forbidden', `POST ${path} refuses with the role code`);
    }

    // The refusals are refusals, not silent no-ops: the order is still on the board, undeleted.
    const board = await (await f.get('/api/studio', f.operator)).json();
    assert.ok(board.orders.some((o) => o.orderId === '1510'), 'nothing the printer was refused took effect');
    assert.ok(!existsSync(join(f.dir, 'hidden.json')), 'the delete it was refused wrote no marker');
  } finally {
    f.cleanup();
  }
});

test('the printer reaches everything printing a book needs, end to end', async () => {
  const f = await roleServer();
  try {
    for (const path of ['/', '/review', '/api/state', '/api/studio', '/img/1510/clean/coloring', '/svg/1510/clean', '/api/1510/pdf', '/api/1510/zip']) {
      const res = await f.get(path, f.printer);
      assert.equal(res.status, 200, `GET ${path} is served for the printer`);
    }

    assert.equal((await f.post('/api/1510/clean/approve', f.printer)).status, 200, 'a photo verdict is the printer\'s to give');
    assert.equal((await f.post('/api/1510/dedication', f.printer, { text: 'Pro Barču' })).status, 200, 'so is the title page');
    assert.equal((await f.post('/api/1510/printed', f.printer)).status, 200, 'and the printed mark (R10)');
    assert.equal((await f.post('/api/1510/unprinted', f.printer)).status, 200, 'and undoing it');
    assert.equal((await f.post('/api/_select', f.printer, { orders: null })).status, 200, 'ticking orders for a run');
    assert.equal((await f.post('/api/_stop', f.printer)).status, 200, 'and stopping one');

    // Generation: with WhatsApp gone Jirka fetches the book himself, so he must be able to make one.
    // `only: []` makes startRun refuse before it spends anything — a 409 here proves the route was
    // REACHED, which is what this test is about, without starting a pipeline.
    const run = await f.post('/api/_run', f.printer, { only: [] });
    assert.equal(run.status, 409, 'the run route is reached (and then refuses an empty selection)');
    assert.match((await run.json()).error, /[Tt]ick at least one order/, 'refused by the run rule, not by the role rule');
  } finally {
    f.cleanup();
  }
});

test('the state endpoint names the signed-in person and carries no credential material', async () => {
  const f = await roleServer();
  try {
    const res = await f.get('/api/state', f.printer);
    const body = await res.text();
    const state = JSON.parse(body);
    assert.equal(state.identity.role, 'printer', 'the page is told which role it is painting for');
    assert.equal(state.identity.username, 'Jirka', 'and the name that person answers to');
    assert.equal(state.identity.implicit, false, 'a real session, not the local-mode implicit operator');

    for (const secret of ['scrypt$', 'PASS_HASH', 'password', PASSWORD, f.printer.split('=')[1]]) {
      assert.ok(!body.includes(secret), `no ${secret} reaches the page`);
    }

    const board = await (await f.get('/api/studio', f.operator)).json();
    assert.equal(board.identity.role, 'operator', 'the board carries it too, so the first paint is right');
    assert.equal(board.identity.username, 'David');
  } finally {
    f.cleanup();
  }
});

test('AE6 — the dashboard guards the view RESOLVER, not just the nav control', async () => {
  const f = await roleServer();
  try {
    const html = await (await f.get('/', f.printer)).text();
    // go() is reached by a click, by the fragment on first load, by the back button and by Escape.
    // The guard has to be inside it, or "#settings" typed into the address bar opens the view.
    assert.match(html, /function go\(v\)\{[\s\S]{0,600}?!viewAllowed\(v\)/, 'the resolver itself refuses a view the role may not reach');
    assert.match(html, /OPERATOR_VIEWS=\[[^\]]*"settings"[^\]]*\]/, 'settings is named as an operator-only view');
    assert.match(html, /window\.addEventListener\("popstate",\(\)=>go\(/, 'history navigation goes through the guarded resolver');
    assert.match(html, /data-view="settings" data-operator/, 'and the control is hidden as well, so it is not offered at all');

    // The page is only ever the second line of defence: the data behind that view is refused anyway.
    assert.equal((await f.get('/api/settings', f.printer)).status, 403, 'and the screen would have nothing to show');
  } finally {
    f.cleanup();
  }
});

test('no route in the dispatcher is undecided: every one has a line in ROUTE_POLICY', () => {
  // The drift guard. It reads the DISPATCHER's own source — everything inside createServer — pulls
  // out every route it branches on, and fails when one of them is not recorded in the policy table.
  // Add a route, forget the policy line, and this test is red before the route can be shipped open.
  const source = readFileSync(new URL('../src/ui/server.js', import.meta.url), 'utf8');
  const start = source.indexOf('const server = createServer(');
  assert.ok(start > 0, 'the dispatcher is still one createServer call — this test reads its source');
  const dispatcher = source.slice(start); // deliberately excludes ROUTE_POLICY itself: no circularity

  /** Constants the dispatcher routes on, resolved to the paths they hold. */
  const PATH_CONSTANTS = { LOGIN_PAGE_PATH, SIGN_IN_PATH, SIGN_OUT_PATH };
  /** `api` is the prefix nearly every route shares, not a route. It is the only such segment, and
   *  naming it here is cheaper than teaching the scan to understand path shapes. */
  const STRUCTURAL = new Set(['api']);

  const found = new Set();
  for (const m of dispatcher.matchAll(/url\.pathname === (?:'([^']*)'|([A-Za-z_$][\w$]*))/g)) {
    if (m[1] !== undefined) {
      found.add(m[1]);
      continue;
    }
    const resolved = PATH_CONSTANTS[m[2]];
    assert.ok(resolved, `the dispatcher routes on the constant ${m[2]}, which this scan cannot resolve — add it to PATH_CONSTANTS and record the route in ROUTE_POLICY`);
    found.add(resolved);
  }
  for (const m of dispatcher.matchAll(/parts\[\d\] === '([^']*)'/g)) found.add(m[1]);
  for (const m of dispatcher.matchAll(/\baction === '([^']*)'/g)) found.add(m[1]);
  for (const s of STRUCTURAL) found.delete(s);

  const decided = new Set(ROUTE_POLICY.flatMap((r) => r.tokens));
  const undecided = [...found].filter((t) => !decided.has(t)).sort();
  assert.deepEqual(
    undecided,
    [],
    `these routes exist in the dispatcher with nobody having decided who may reach them: ${undecided.join(', ')}. ` +
      `Add a line to ROUTE_POLICY in src/ui/server.js — an unrecorded route is refused for the printer, but ` +
      `refused-by-accident is not a decision.`,
  );

  const stale = [...decided].filter((t) => !found.has(t)).sort();
  assert.deepEqual(stale, [], `ROUTE_POLICY records routes the dispatcher no longer has: ${stale.join(', ')}`);

  // Every entry says who, and nothing says "everyone" by omission.
  for (const entry of ROUTE_POLICY) {
    assert.ok(['anyone', 'both', 'operator'].includes(entry.audience), `${entry.id} names a real audience`);
    assert.equal(typeof entry.match, 'function', `${entry.id} can be matched against a request`);
  }
});
