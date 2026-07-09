import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { runPipeline, buildabilityProblem, ORDER_STATUS } from '../src/orchestrator.js';
import { approve, setOrderDedication } from '../src/review.js';
import { GeneratorError } from '../src/generator/driver.js';
import { BuilderError } from '../src/builder/builderDriver.js';
import { STATES, readManifest, getStatus } from '../src/manifest.js';
import { photoBase } from '../src/organize.js';

const CONFIG = {
  generator: { baseUrl: 'https://example.test/tok', mode: 'api', variant: '2509_1.5', diffusionSteps: 8 },
  builder: { baseUrl: 'https://example.test/builder', pdf: {} },
  paths: { inbox: './inbox', outbox: './outbox' },
};

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10"/></svg>';
const OK_QC = async () => ({ verdict: 'ok', reason: 'ok' });
const BAD_QC = async () => ({ verdict: 'flagged', reason: 'near-blank' });

class StubGenerator {
  constructor({ failOn = [] } = {}) {
    this.failOn = new Set(failOn);
    this.calls = [];
    this.workDir = mkdtempSync(join(tmpdir(), 'fma-gen-'));
  }
  async generate(photoPath) {
    const base = photoBase(photoPath);
    this.calls.push(base);
    if (this.failOn.has(base)) throw new GeneratorError('Generation failed on the GPU: worker lost', { step: 'poll' });
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

class StubBuilder {
  constructor({ failOn = [] } = {}) {
    this.failOn = new Set(failOn);
    this.calls = [];
  }
  async buildPdf(orderDir, options) {
    this.calls.push({ orderDir, options });
    if ([...this.failOn].some((f) => orderDir.endsWith(f))) {
      throw new BuilderError('Could not open the builder page: net::ERR_CONNECTION_REFUSED', { step: 'load' });
    }
    writeFileSync(options.outPdfPath, '%PDF-1.4\nstub\n');
    return { pdfPath: options.outPdfPath, pairs: 1 };
  }
}

function fixture(orders) {
  const root = mkdtempSync(join(tmpdir(), 'fma-orch-'));
  const inbox = join(root, 'inbox');
  const outbox = join(root, 'outbox');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(outbox, { recursive: true });
  for (const [orderId, names] of Object.entries(orders)) {
    mkdirSync(join(inbox, orderId), { recursive: true });
    for (const n of names) writeFileSync(join(inbox, orderId, `${n}.jpeg`), 'photo');
  }
  return { root, inbox, outbox, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const run = (f, opts = {}) =>
  runPipeline({
    config: CONFIG,
    inboxRoot: f.inbox,
    outboxRoot: f.outbox,
    generator: opts.generator ?? new StubGenerator(),
    builder: opts.builder ?? new StubBuilder(),
    qc: opts.qc ?? OK_QC,
    force: opts.force ?? false,
    onEvent: opts.onEvent,
  });

test('one order runs ingest -> generate -> QC -> builder -> a real PDF path', async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    const builder = new StubBuilder();
    const { orders, counts } = await run(f, { builder });

    assert.equal(counts.done, 1);
    assert.equal(orders[0].status, ORDER_STATUS.DONE);
    assert.match(orders[0].pdfPath, /1510 Final\.pdf$/);
    assert.ok(existsSync(orders[0].pdfPath));
    assert.equal(builder.calls.length, 1);
    assert.equal(getStatus(readManifest(orders[0].orderDir), 'a'), STATES.OK);
  } finally {
    f.cleanup();
  }
});

test('a flagged photo blocks only its own order; the others still print', async () => {
  const f = fixture({ 1510: ['bad'], 1523: ['good'] });
  try {
    const builder = new StubBuilder();
    // Only 1510's photo trips the QC tripwire.
    const qc = async (out) => (out.base === 'bad' ? { verdict: 'flagged', reason: 'near-blank' } : { verdict: 'ok', reason: 'ok' });
    const { orders, counts } = await run(f, { builder, qc });

    const [o1510, o1523] = orders;
    assert.equal(o1510.status, ORDER_STATUS.HELD);
    assert.equal(o1510.pdfPath, null, 'a held order must never reach the builder');
    assert.deepEqual(o1510.held, ['bad']);
    assert.match(o1510.reason, /waiting for you/);

    assert.equal(o1523.status, ORDER_STATUS.DONE);
    assert.ok(existsSync(o1523.pdfPath));

    assert.deepEqual(builder.calls.map((c) => c.orderDir.endsWith('1523')), [true], 'builder saw only the ready order');
    assert.deepEqual(counts, { done: 1, held: 1, failed: 0 });
  } finally {
    f.cleanup();
  }
});

test('approving the flagged photo lets the next run print that order', async () => {
  const f = fixture({ 1510: ['bad'] });
  try {
    const first = await run(f, { qc: BAD_QC });
    assert.equal(first.orders[0].status, ORDER_STATUS.HELD);

    approve(first.orders[0].orderDir, 'bad');

    const builder = new StubBuilder();
    const generator = new StubGenerator();
    const second = await run(f, { builder, generator, qc: BAD_QC });

    assert.equal(second.orders[0].status, ORDER_STATUS.DONE);
    assert.ok(existsSync(second.orders[0].pdfPath));
    assert.deepEqual(generator.calls, [], 'an approved photo is not regenerated');
    assert.equal(builder.calls.length, 1);
  } finally {
    f.cleanup();
  }
});

test('a generator break names its seam, fails only that order, and never reaches the builder', async () => {
  const f = fixture({ 1510: ['boom'], 1523: ['fine'] });
  try {
    const builder = new StubBuilder();
    const events = [];
    const { orders, counts } = await run(f, {
      generator: new StubGenerator({ failOn: ['boom'] }),
      builder,
      onEvent: (e) => events.push(e),
    });

    const failed = orders.find((o) => o.orderId === '1510');
    assert.equal(failed.status, ORDER_STATUS.FAILED);
    assert.deepEqual(failed.failed, ['boom']);
    assert.match(failed.reason, /generator seam \(poll\)/);
    assert.ok(!failed.reason.includes('    at '), 'no stack trace reaches the operator');
    assert.equal(failed.pdfPath, null);

    assert.equal(orders.find((o) => o.orderId === '1523').status, ORDER_STATUS.DONE);
    assert.deepEqual(builder.calls.map((c) => c.orderDir.endsWith('1523')), [true]);
    assert.deepEqual(counts, { done: 1, held: 0, failed: 1 });
    assert.ok(events.some((e) => e.type === 'photo-failed' && e.base === 'boom'));
  } finally {
    f.cleanup();
  }
});

test('a builder break names its seam, fails only that order, and the batch continues', async () => {
  const f = fixture({ 1510: ['a'], 1523: ['b'] });
  try {
    const builder = new StubBuilder({ failOn: ['1510'] });
    const { orders, counts } = await run(f, { builder });

    const broken = orders.find((o) => o.orderId === '1510');
    assert.equal(broken.status, ORDER_STATUS.FAILED);
    assert.match(broken.reason, /^builder seam \(load\): Could not open the builder page/);
    assert.ok(!broken.reason.includes('    at '));
    assert.equal(broken.pdfPath, null);

    assert.equal(orders.find((o) => o.orderId === '1523').status, ORDER_STATUS.DONE);
    assert.deepEqual(counts, { done: 1, held: 0, failed: 1 });
    // The generated photos survive: a rerun rebuilds the PDF without regenerating.
    assert.equal(getStatus(readManifest(broken.orderDir), 'a'), STATES.OK);
  } finally {
    f.cleanup();
  }
});

test('a rerun regenerates nothing and does not rebuild an up-to-date PDF', async () => {
  const f = fixture({ 1510: ['a', 'b'] });
  try {
    const first = await run(f);
    const pdfPath = first.orders[0].pdfPath;
    const stamp = statSync(pdfPath).mtimeMs;

    const generator = new StubGenerator();
    const builder = new StubBuilder();
    const second = await run(f, { generator, builder });

    assert.equal(second.orders[0].status, ORDER_STATUS.DONE);
    assert.deepEqual(generator.calls, [], 'no redundant generation');
    assert.deepEqual(builder.calls, [], 'no redundant printing');
    assert.equal(statSync(pdfPath).mtimeMs, stamp, 'the PDF was not touched');
  } finally {
    f.cleanup();
  }
});

test('a verdict changed after the PDF was printed makes it stale, and it is rebuilt', async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    const first = await run(f);
    const { orderDir, pdfPath } = first.orders[0];

    // The operator marks it bad and re-approves it after the print: state.json is now newer.
    approve(orderDir, 'a');
    assert.ok(statSync(join(orderDir, 'state.json')).mtimeMs >= statSync(pdfPath).mtimeMs);

    const builder = new StubBuilder();
    await run(f, { builder });
    assert.equal(builder.calls.length, 1, 'a changed verdict reprints the book');
  } finally {
    f.cleanup();
  }
});

test('force reprints an up-to-date PDF', async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    await run(f);
    const builder = new StubBuilder();
    await run(f, { builder, force: true });
    assert.equal(builder.calls.length, 1);
  } finally {
    f.cleanup();
  }
});

test('the builder is handed the configured layout options and the order-named output path', async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    const builder = new StubBuilder();
    const config = { ...CONFIG, builder: { ...CONFIG.builder, pdf: { mode: 'gallery', addAllCovers: true, rotationMin: -2 } } };
    await runPipeline({ config, inboxRoot: f.inbox, outboxRoot: f.outbox, generator: new StubGenerator(), builder, qc: OK_QC });

    const { options } = builder.calls[0];
    assert.equal(options.mode, 'gallery');
    assert.equal(options.addAllCovers, true);
    assert.equal(options.rotationMin, -2);
    assert.match(options.outPdfPath, /1510 Final\.pdf$/);
  } finally {
    f.cleanup();
  }
});

// ---- the title page --------------------------------------------------------

test('an order with no dedication prints without a title page, and the report says so', async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    const builder = new StubBuilder();
    const { orders } = await run(f, { builder });

    assert.equal(orders[0].status, ORDER_STATUS.DONE);
    assert.equal(builder.calls[0].options.dedication, undefined);
    assert.match(orders[0].warning, /no title page/);
  } finally {
    f.cleanup();
  }
});

test("the operator's dedication reaches the builder and clears the warning", async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    const first = await run(f);
    setOrderDedication(first.orders[0].orderDir, '  Pro Barču, s láskou  ');

    const builder = new StubBuilder();
    const { orders } = await run(f, { builder });

    assert.equal(builder.calls[0].options.dedication, 'Pro Barču, s láskou', 'trimmed, and it is the title-page text');
    assert.equal(orders[0].warning, null);
  } finally {
    f.cleanup();
  }
});

test('changing the dedication reprints the book', async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    const first = await run(f);
    const { orderDir } = first.orders[0];

    const unchanged = new StubBuilder();
    await run(f, { builder: unchanged });
    assert.equal(unchanged.calls.length, 0, 'nothing changed, nothing reprinted');

    setOrderDedication(orderDir, 'Pro Barču');
    const reprint = new StubBuilder();
    await run(f, { builder: reprint });
    assert.equal(reprint.calls.length, 1, 'a new title page means a new book');
    assert.equal(reprint.calls[0].options.dedication, 'Pro Barču');
  } finally {
    f.cleanup();
  }
});

test('a per-order dedication overrides a configured default title', async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    const first = await run(f);
    setOrderDedication(first.orders[0].orderDir, 'Pro Barču');

    const builder = new StubBuilder();
    const config = { ...CONFIG, builder: { ...CONFIG.builder, pdf: { title: 'a global default' } } };
    await runPipeline({ config, inboxRoot: f.inbox, outboxRoot: f.outbox, generator: new StubGenerator(), builder, qc: OK_QC });

    // BuilderDriver reads `dedication ?? title`, so the customer's text wins.
    assert.equal(builder.calls[0].options.dedication, 'Pro Barču');
  } finally {
    f.cleanup();
  }
});

test('an empty inbox produces an empty report, not a crash', async () => {
  const f = fixture({});
  try {
    const { orders, counts } = await run(f);
    assert.deepEqual(orders, []);
    assert.deepEqual(counts, { done: 0, held: 0, failed: 0 });
  } finally {
    f.cleanup();
  }
});

test('a missing inbox stops the run with the ingest seam, not a stack trace', async () => {
  const f = fixture({});
  try {
    rmSync(f.inbox, { recursive: true, force: true });
    await assert.rejects(() => run(f), (err) => {
      assert.equal(err.seam, 'ingest');
      assert.match(err.message, /Input folder not found/);
      return true;
    });
  } finally {
    f.cleanup();
  }
});

// ---- the gate at the builder's door ----------------------------------------

test('a photo with no coloring page is surfaced before export, even against a current PDF', async () => {
  const f = fixture({ 1510: ['a', 'b'] });
  try {
    const first = await run(f);
    const { orderDir } = first.orders[0];
    // The folder changed under the operator: a hand edit, a half-finished copy. The PDF on
    // disk still looks up to date, and reusing it would ship a book that no longer matches.
    rmSync(join(orderDir, 'b.svg'));

    const builder = new StubBuilder();
    const { orders } = await run(f, { builder, generator: new StubGenerator() });

    assert.equal(orders[0].status, ORDER_STATUS.FAILED);
    assert.match(orders[0].reason, /builder seam \(load\): 1 photo\(s\) have no coloring page/);
    assert.match(orders[0].reason, /\bb\b/);
    assert.equal(builder.calls.length, 0, 'refused before the browser was ever launched');
  } finally {
    f.cleanup();
  }
});

test('a stray pair in the order folder is refused rather than printed into the book', async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    const first = await run(f);
    const { orderDir } = first.orders[0];
    // Someone else's photo, dropped in the folder. It pairs, so the builder would print it
    // into this customer's book. Nothing downstream would notice.
    writeFileSync(join(orderDir, 'someone_elses_child.jpg'), 'jpeg');
    writeFileSync(join(orderDir, 'someone_elses_child.svg'), SVG);

    const builder = new StubBuilder();
    const { orders } = await run(f, { builder });

    assert.equal(orders[0].status, ORDER_STATUS.FAILED);
    assert.match(orders[0].reason, /not part of this order/);
    assert.match(orders[0].reason, /someone_elses_child/);
    assert.equal(builder.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

test('buildabilityProblem passes a folder holding exactly the order', async () => {
  const f = fixture({ 1510: ['a', 'b'] });
  try {
    const { orders } = await run(f);
    assert.equal(buildabilityProblem(orders[0].orderDir, ['a', 'b']), null);
  } finally {
    f.cleanup();
  }
});
