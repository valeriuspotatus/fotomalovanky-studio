import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createReviewServer } from '../src/ui/server.js';
import { STATES, readManifest, getStatus, emptyManifest, setDedication, writeManifest } from '../src/manifest.js';
import { photoBase } from '../src/organize.js';

const CONFIG = {
  generator: { baseUrl: 'https://example.test/tok', mode: 'api', variant: '2509_1.5', diffusionSteps: 8 },
  builder: { baseUrl: 'https://example.test/builder', pdf: {} },
  paths: { inbox: './inbox', outbox: './outbox' },
};
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10"/></svg>';

/** A stand-in coloring raster: 1px lines with white paper between them. Half ink, but nothing
 *  filled — a solid black block would trip qc's solid-fill tripwire, and rightly so. */
const LINE_ART = Buffer.alloc(8 * 8, 255);
for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) LINE_ART[y * 8 + x] = 0;
const RAW_8 = { raw: { width: 8, height: 8, channels: 1 } };

/** Generator that parks on `gate` so the test can inspect a run while it is in flight. */
class GatedGenerator {
  constructor() {
    this.workDir = mkdtempSync(join(tmpdir(), 'fma-gen-'));
    this.started = 0;
    this.release = () => {};
    this.gate = new Promise((r) => (this.release = r));
  }
  async generate(photoPath) {
    this.started++;
    await this.gate;
    const base = photoBase(photoPath);
    const originalPath = join(this.workDir, `${base}.jpeg`);
    const coloringPngPath = join(this.workDir, `${base}_bw.png`);
    const coloringSvgPath = join(this.workDir, `${base}.svg`);
    writeFileSync(originalPath, 'jpeg-bytes');
    await sharp(LINE_ART, RAW_8).png().toFile(coloringPngPath);
    writeFileSync(coloringSvgPath, SVG);
    return { originalPath, coloringPngPath, coloringSvgPath };
  }
}

const stubBuilder = {
  async buildPdf(orderDir, options) {
    writeFileSync(options.outPdfPath, '%PDF-1.4\nstub\n');
    return { pdfPath: options.outPdfPath, pairs: 1 };
  },
};

// These tests use tiny stand-in JPEGs that real intake would hold as too small to print. They are
// about run / stop / reveal mechanics, not the input QC, so intake is stubbed ok — the gate itself
// is covered in intake.test.js and orchestrator.test.js.
const OK_INTAKE = async () => ({ verdict: 'ok', findings: [], expected: null, uploaded: 0, unique: 0, emailCase: null });

let root, inbox, outbox, orderDir, server, origin, generator;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'fma-run-'));
  inbox = join(root, 'inbox');
  outbox = join(root, 'outbox');
  orderDir = join(outbox, '1510');
  mkdirSync(join(inbox, '1510'), { recursive: true });
  mkdirSync(orderDir, { recursive: true });
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ccc' } }).jpeg().toFile(join(inbox, '1510', 'a.jpeg'));
  // The run holds an order with no title text, so give this one a dedication up front.
  writeManifest(orderDir, setDedication(emptyManifest('1510'), 'Pro Barču'));

  generator = new GatedGenerator();
  ({ server } = createReviewServer({ config: CONFIG, inboxRoot: inbox, outboxRoot: outbox, memoryRoot: outbox, driver: generator, builder: stubBuilder, intake: OK_INTAKE }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

const getState = async () => (await fetch(`${origin}/api/state`)).json();
const post = (path, body) =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function until(fn, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for a condition');
}

test('a run does not start when the folder does not exist, and nothing is marked running', async () => {
  const res = await post('/api/_run', { inbox: join(root, 'nope') });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Input folder not found/);

  const { run, inbox: current } = await getState();
  assert.equal(run.active, false);
  assert.equal(current, inbox, 'the tool still points at the folder it did before');
});

test('Go starts the pipeline and streams progress lines', async () => {
  const res = await post('/api/_run', { inbox });
  assert.equal(res.status, 202);

  await until(async () => (await getState()).run.active);
  await until(async () => (await getState()).run.lines.some((l) => l.includes('objednávka 1510')));
  assert.equal(generator.started, 1, 'the generator is actually working');
});

test('a second Go while one is running is refused', async () => {
  const res = await post('/api/_run', { inbox });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /already going/);
});

test('verdicts are refused while a run rewrites the manifests', async () => {
  // The run holds each order's manifest in memory; a verdict saved now would be overwritten.
  for (const path of ['/api/1510/a/approve', '/api/1510/a/reject', '/api/1510/a/redo']) {
    const res = await post(path);
    assert.equal(res.status, 409, path);
    assert.match((await res.json()).error, /run is in progress/);
  }
  const ded = await post('/api/1510/dedication', { text: 'nope' });
  assert.equal(ded.status, 409);
  assert.match((await ded.json()).error, /run is in progress/);
});

test('the run finishes, reports per-order status, and reopens the review gate', async () => {
  generator.release();
  await until(async () => (await getState()).run.report !== null, 20_000);

  const { run, orders } = await getState();
  assert.equal(run.active, false);
  assert.equal(run.error, null);
  assert.deepEqual(run.report.counts, { done: 1, ready: 0, held: 0, failed: 0 });
  assert.equal(run.report.orders[0].orderId, '1510');
  assert.equal(run.report.orders[0].status, 'done');
  assert.equal(run.report.orders[0].pdf, true);

  assert.ok(existsSync(join(orderDir, '1510 Final.pdf')));
  assert.equal(getStatus(readManifest(orderDir), 'a'), STATES.OK);
  assert.equal(orders[0].photos[0].builderEligible, true);

  // The gate is open again now that nothing is rewriting state.json.
  const res = await post('/api/1510/a/reject');
  assert.equal(res.status, 200);
});

test('the run log never carries the generator token', async () => {
  const body = JSON.stringify(await getState());
  assert.ok(!body.includes('example.test/tok'));
});

// ---- revealing the finished book --------------------------------------------

/** A run on its own server, so the shared one's state stays untouched. Records what the server
 *  would have opened on the desktop instead of really opening it. */
async function runOnce(opts) {
  const r = mkdtempSync(join(tmpdir(), 'fma-reveal-'));
  const inb = join(r, 'inbox');
  const outb = join(r, 'outbox');
  const dir = join(outb, '1510');
  mkdirSync(join(inb, '1510'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ccc' } }).jpeg().toFile(join(inb, '1510', 'a.jpeg'));
  writeManifest(dir, setDedication(emptyManifest('1510'), 'Pro Barču'));

  const gen = new GatedGenerator();
  gen.release();
  const revealed = [];
  const { server: s } = createReviewServer({
    config: CONFIG,
    inboxRoot: inb,
    outboxRoot: outb,
    driver: gen,
    builder: stubBuilder,
    intake: OK_INTAKE,
    reveal: (p) => revealed.push(p),
    ...opts,
  });
  await new Promise((done) => s.listen(0, '127.0.0.1', done));
  const origin2 = `http://127.0.0.1:${s.address().port}`;
  await fetch(`${origin2}/api/_run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  const deadline = Date.now() + 20_000;
  for (;;) {
    const st = await (await fetch(`${origin2}/api/state`)).json();
    if (st.run.report) break;
    if (Date.now() > deadline) throw new Error('the run never finished');
    await new Promise((done) => setTimeout(done, 50));
  }
  s.close();
  return { revealed, orderDir: dir, cleanup: () => rmSync(r, { recursive: true, force: true }) };
}

test('a finished run leaves the desktop alone unless the launcher asked for it', async () => {
  const { revealed, cleanup } = await runOnce({});
  try {
    // A test or a smoke that builds a server must never spawn a File Explorer window — least of
    // all onto a temp folder it is about to delete.
    assert.deepEqual(revealed, []);
  } finally {
    cleanup();
  }
});

test("the launcher opens the finished book's folder when the run is done", async () => {
  const { revealed, orderDir: dir, cleanup } = await runOnce({ revealFinished: true });
  try {
    assert.deepEqual(revealed, [dir]);
  } finally {
    cleanup();
  }
});

// ---- the Stop button --------------------------------------------------------

test('Stop ends a run in flight, and the tool comes back to rest', async () => {
  const r = mkdtempSync(join(tmpdir(), 'fma-stop-'));
  const inb = join(r, 'inbox');
  const outb = join(r, 'outbox');
  // Two orders, so Stop has a second one to spare while the first is parked on the gate.
  for (const id of ['1601', '1602']) {
    mkdirSync(join(inb, id), { recursive: true });
    mkdirSync(join(outb, id), { recursive: true });
    await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ccc' } }).jpeg().toFile(join(inb, id, 'a.jpeg'));
    writeManifest(join(outb, id), setDedication(emptyManifest(id), 'Pro Barču'));
  }

  const gen = new GatedGenerator(); // parks on the first photo until released
  const { server: s } = createReviewServer({ config: CONFIG, inboxRoot: inb, outboxRoot: outb, memoryRoot: outb, driver: gen, builder: stubBuilder, intake: OK_INTAKE });
  await new Promise((done) => s.listen(0, '127.0.0.1', done));
  const o = `http://127.0.0.1:${s.address().port}`;
  const state = async () => (await fetch(`${o}/api/state`)).json();
  const waitFor = async (fn, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn(await state())) return; await new Promise((d) => setTimeout(d, 25)); }
    throw new Error('timed out');
  };

  try {
    await fetch(`${o}/api/_run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await waitFor((st) => st.run.active && st.run.lines.some((l) => l.includes('objednávka 1601')));

    // Press Stop while the first order is still on the GPU.
    const stopRes = await (await fetch(`${o}/api/_stop`, { method: 'POST' })).json();
    assert.equal(stopRes.stopping, true);
    assert.equal((await state()).run.stopping, true, 'the tool says it is stopping');

    // Release the parked photo; the run should now wind down rather than start the second order.
    gen.release();
    await waitFor((st) => !st.run.active);

    const st = await state();
    assert.equal(st.run.stopping, false, 'it is no longer stopping — it has stopped');
    assert.equal(st.run.report.counts.done, 1, 'the order that finished is done');
    assert.ok(st.run.lines.some((l) => /Zastaveno — 1 z 2/.test(l)), 'the log says what it did');
    assert.equal(gen.started, 1, 'the second order never reached the generator');

    // And Stop with nothing running is a harmless no-op.
    assert.deepEqual(await (await fetch(`${o}/api/_stop`, { method: 'POST' })).json(), { stopping: false });
  } finally {
    s.close();
    rmSync(r, { recursive: true, force: true });
  }
});
