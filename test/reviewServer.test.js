import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createReviewServer, openCommand, powershellPath, openExternally } from '../src/ui/server.js';
import { STATES, readManifest, getStatus, setStatus, writeManifest, emptyManifest } from '../src/manifest.js';

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

  ({ server } = createReviewServer({ config: CONFIG, inboxRoot: inbox, outboxRoot: outbox, driver: { generate: async () => {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

const get = (p) => fetch(`${origin}${p}`);
const post = (p) => fetch(`${origin}${p}`, { method: 'POST' });

test('the grid serves its page', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<title>Fotomalov/);
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
