import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createReviewServer } from '../src/ui/server.js';
import { STATES, readManifest, getStatus } from '../src/manifest.js';
import { photoBase } from '../src/organize.js';

const CONFIG = {
  generator: { baseUrl: 'https://example.test/tok', mode: 'api', variant: '2509_1.5', diffusionSteps: 8 },
  builder: { baseUrl: 'https://example.test/builder', pdf: {} },
  paths: { inbox: './inbox', outbox: './outbox' },
};
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10"/></svg>';

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
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } })
      .composite([{ input: { create: { width: 8, height: 4, channels: 3, background: '#000000' } }, top: 0, left: 0 }])
      .png()
      .toFile(coloringPngPath);
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

let root, inbox, outbox, orderDir, server, origin, generator;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'fma-run-'));
  inbox = join(root, 'inbox');
  outbox = join(root, 'outbox');
  orderDir = join(outbox, '1510');
  mkdirSync(join(inbox, '1510'), { recursive: true });
  mkdirSync(outbox, { recursive: true });
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ccc' } }).jpeg().toFile(join(inbox, '1510', 'a.jpeg'));

  generator = new GatedGenerator();
  ({ server } = createReviewServer({ config: CONFIG, inboxRoot: inbox, outboxRoot: outbox, driver: generator, builder: stubBuilder }));
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
  await until(async () => (await getState()).run.lines.some((l) => l.includes('order 1510')));
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
  assert.deepEqual(run.report.counts, { done: 1, held: 0, failed: 0 });
  assert.equal(run.report.orders[0].orderId, '1510');
  assert.equal(run.report.orders[0].status, 'done');
  assert.equal(run.report.orders[0].pdf, true);
  assert.match(run.report.orders[0].warning, /no title page/);

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
