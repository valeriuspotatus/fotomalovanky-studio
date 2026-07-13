import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { runPipeline, buildabilityProblem, formatEvent, ORDER_STATUS } from '../src/orchestrator.js';
import { approve, setOrderDedication, overrideIntake } from '../src/review.js';
import { GeneratorError } from '../src/generator/driver.js';
import { BuilderError } from '../src/builder/builderDriver.js';
import { STATES, readManifest, getStatus, getDedication, getIntake, emptyManifest, setDedication, writeManifest, manifestPath } from '../src/manifest.js';
import { photoBase } from '../src/organize.js';

/** A stand-in coloring raster: 1px lines with white paper between them. Half ink, but nothing
 *  filled — a solid black block would trip qc's solid-fill tripwire, and rightly so. */
const LINE_ART = Buffer.alloc(8 * 8, 255);
for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) LINE_ART[y * 8 + x] = 0;
const RAW_8 = { raw: { width: 8, height: 8, channels: 1 } };

const CONFIG = {
  generator: { baseUrl: 'https://example.test/tok', mode: 'api', variant: '2509_1.5', diffusionSteps: 8 },
  builder: { baseUrl: 'https://example.test/builder', pdf: {} },
  paths: { inbox: './inbox', outbox: './outbox' },
};

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10"/></svg>';
const OK_QC = async () => ({ verdict: 'ok', reason: 'ok' });
const BAD_QC = async () => ({ verdict: 'flagged', reason: 'near-blank' });

// Intake is injected like qc. The fixtures write fake 'photo' bytes no image library can decode,
// so the real intake would hold every order as "unreadable"; these tests are about generation and
// building, so they stub it ok. The gate itself is exercised with holdIntake below.
const OK_INTAKE = async () => ({ verdict: 'ok', findings: [], expected: null, uploaded: 0, unique: 0, emailCase: null });
const holdIntake = (over = {}) => async () => ({
  verdict: 'hold',
  emailCase: 'missing',
  expected: 8,
  uploaded: 5,
  unique: 5,
  findings: [{ check: 'count', verdict: 'hold', reason: 'missing-photos', expected: 8, uploaded: 5, unique: 5, missing: 3 }],
  ...over,
});

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
    await sharp(LINE_ART, RAW_8).png().toFile(coloringPngPath);
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

const DEDICATION = 'Pro Barču, s láskou';

/** Seeds each order with a dedication, because most real ones have one. Pass `{ dedication: null }`
 *  for a customer who wrote nothing — their book prints too, with an empty title line. */
function fixture(orders, { dedication = DEDICATION } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fma-orch-'));
  const inbox = join(root, 'inbox');
  const outbox = join(root, 'outbox');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(outbox, { recursive: true });
  for (const [orderId, names] of Object.entries(orders)) {
    mkdirSync(join(inbox, orderId), { recursive: true });
    for (const n of names) writeFileSync(join(inbox, orderId, `${n}.jpeg`), 'photo');
    if (dedication) {
      mkdirSync(join(outbox, orderId), { recursive: true });
      writeManifest(join(outbox, orderId), setDedication(emptyManifest(orderId), dedication));
    }
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
    intake: opts.intake ?? OK_INTAKE,
    force: opts.force ?? false,
    buildPdfs: opts.buildPdfs,
    only: opts.only,
    signal: opts.signal,
    onEvent: opts.onEvent,
  });

/** Force an order's state.json to read as newer than any PDF already built from it. A verdict or
 *  dedication change and the prior print can land in the same coarse filesystem mtime tick (seen on
 *  Windows), which would let a stale PDF count as current and skip the rebuild; in real use the
 *  operator's edit comes long after the book was printed. Keeps the rebuild-on-change tests
 *  deterministic without touching the production `pdfIsCurrent` semantics. */
const markStateChanged = (orderDir) => {
  const t = new Date(Date.now() + 5000);
  utimesSync(manifestPath(orderDir), t, t);
};

/** A generator that trips the Stop button the moment it finishes a given photo, so a test can
 *  make cancellation land at an exact boundary without real timing. */
class StoppingGenerator extends StubGenerator {
  constructor(controller, stopAfter) {
    super();
    this.controller = controller;
    this.stopAfter = stopAfter;
  }
  async generate(photoPath) {
    const result = await super.generate(photoPath);
    if (photoBase(photoPath) === this.stopAfter) this.controller.abort();
    return result;
  }
}

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

test('Go (buildPdfs:false) generates but does not build; PDF builds without regenerating', async () => {
  const f = fixture({ 1510: ['a', 'b'] });
  try {
    const generator = new StubGenerator();
    const builder = new StubBuilder();

    // "Go" — generate the pages only. No PDF, the builder is never touched, the order reads ready.
    const first = await run(f, { generator, builder, buildPdfs: false });
    assert.equal(first.orders[0].status, ORDER_STATUS.READY);
    assert.equal(first.orders[0].pdfPath, null);
    assert.equal(first.counts.ready, 1);
    assert.equal(first.counts.done, 0);
    assert.equal(builder.calls.length, 0, 'a generate-only run never builds');
    assert.equal(generator.calls.length, 2, 'both photos were generated');

    // "PDF" — build the book. Generation is idempotent, so the GPU is not touched again.
    const second = await run(f, { generator, builder, buildPdfs: true });
    assert.equal(second.orders[0].status, ORDER_STATUS.DONE);
    assert.ok(second.orders[0].pdfPath && existsSync(second.orders[0].pdfPath));
    assert.equal(builder.calls.length, 1, 'the build ran once, on the PDF step');
    assert.equal(generator.calls.length, 2, 'the PDF step regenerated nothing');
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
    assert.match(o1510.reason, /čeká na vaši kontrolu/);

    assert.equal(o1523.status, ORDER_STATUS.DONE);
    assert.ok(existsSync(o1523.pdfPath));

    assert.deepEqual(builder.calls.map((c) => c.orderDir.endsWith('1523')), [true], 'builder saw only the ready order');
    assert.deepEqual(counts, { done: 1, ready: 0, held: 1, failed: 0 });
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
    assert.deepEqual(counts, { done: 1, ready: 0, held: 0, failed: 1 });
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
    assert.deepEqual(counts, { done: 1, ready: 0, held: 0, failed: 1 });
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
    markStateChanged(orderDir); // the edit comes long after the print; don't race the mtime tick
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
    await runPipeline({ config, inboxRoot: f.inbox, outboxRoot: f.outbox, generator: new StubGenerator(), builder, qc: OK_QC, intake: OK_INTAKE });

    const { options } = builder.calls[0];
    assert.equal(options.mode, 'gallery');
    assert.equal(options.addAllCovers, true);
    assert.equal(options.rotationMin, -2);
    assert.match(options.outPdfPath, /1510 Final\.pdf$/);
  } finally {
    f.cleanup();
  }
});

test('U9: each order builds in the format its product maps to, with no config change mid-burst', async () => {
  const f = fixture({ 1601: ['a'], 1602: ['b'] });
  try {
    // The shop's own record: 1601 sold full-page, 1602 galerie — the extension drops it beside
    // the photos, and the format is derived from it, never re-read from Shopify.
    writeFileSync(join(f.inbox, '1601', 'objednavka.json'), JSON.stringify({ order: '1601', products: [{ variant: 'celo', qty: 1 }] }));
    writeFileSync(join(f.inbox, '1602', 'objednavka.json'), JSON.stringify({ order: '1602', products: [{ variant: 'gal', qty: 1 }] }));
    const config = { ...CONFIG, delivery: { format: 'gallery', formatMap: { celo: 'fullpage', gal: 'gallery' } } };
    const builder = new StubBuilder();
    const formats = [];
    await runPipeline({
      config,
      inboxRoot: f.inbox,
      outboxRoot: f.outbox,
      generator: new StubGenerator(),
      builder,
      qc: OK_QC,
      intake: OK_INTAKE,
      onEvent: (e) => { if (e.type === 'order-format') formats.push([e.orderId, e.mode, e.mapped]); },
    });

    const modeOf = (id) => builder.calls.find((c) => c.orderDir.endsWith(id)).options.mode;
    assert.equal(modeOf('1601'), 'fullpage', 'the full-page order built full-page');
    assert.equal(modeOf('1602'), 'gallery', 'the galerie order built galerie — in the same burst, no config edit');
    formats.sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(formats, [['1601', 'fullpage', true], ['1602', 'gallery', true]]);
  } finally {
    f.cleanup();
  }
});

// ---- the title page --------------------------------------------------------

test('a customer who wrote no dedication still gets their book, with an untexted title page', async () => {
  const f = fixture({ 1510: ['a'] }, { dedication: null }); // "a" carries no "_-_" text to recover
  try {
    const builder = new StubBuilder();
    const { orders, counts } = await run(f, { builder });

    assert.equal(orders[0].status, ORDER_STATUS.DONE);
    assert.equal(orders[0].titled, false, 'the report says the book carries no dedication');
    assert.equal(builder.calls.length, 1, 'the builder is reached');
    assert.equal(builder.calls[0].options.dedication, undefined, 'no title text is sent');
    assert.ok(orders[0].pdfPath);
    assert.deepEqual(counts, { done: 1, ready: 0, held: 0, failed: 0 });
  } finally {
    f.cleanup();
  }
});

test('the run says out loud that a book printed with no dedication', async () => {
  const f = fixture({ 1510: ['a'] }, { dedication: null });
  try {
    const lines = [];
    await run(f, { builder: new StubBuilder(), onEvent: (e) => lines.push(formatEvent(e)) });
    assert.ok(lines.some((l) => l && /není věnování/.test(l)), `expected a spoken warning, got: ${lines.filter(Boolean).join(' | ')}`);
  } finally {
    f.cleanup();
  }
});

test("the operator's dedication reaches the builder and reprints the book", async () => {
  const f = fixture({ 1510: ['a'] }, { dedication: null });
  try {
    const first = await run(f);
    assert.equal(first.orders[0].titled, false);
    setOrderDedication(first.orders[0].orderDir, '  Pro Barču, s láskou  ');
    markStateChanged(first.orders[0].orderDir); // the edit comes long after the print

    const builder = new StubBuilder();
    const { orders } = await run(f, { builder });

    assert.equal(orders[0].status, ORDER_STATUS.DONE);
    assert.equal(orders[0].titled, true);
    assert.equal(builder.calls[0].options.dedication, 'Pro Barču, s láskou', 'trimmed, and it is the title-page text');
  } finally {
    f.cleanup();
  }
});

test('the title page is recovered from the photo names, and only for an undecided order', async () => {
  const f = fixture({ 1521: ['1521_img0001_-_pro_maxinnku_a_estellku'] }, { dedication: null });
  try {
    const builder = new StubBuilder();
    const { orders } = await run(f, { builder });

    assert.equal(orders[0].titled, true);
    assert.equal(builder.calls[0].options.dedication, 'Pro Maxinnku a Estellku');
    assert.equal(getDedication(readManifest(orders[0].orderDir)), 'Pro Maxinnku a Estellku', 'persisted, so the grid shows it');
  } finally {
    f.cleanup();
  }
});

test('an operator who empties the title page is not overruled by the photo names', async () => {
  const f = fixture({ 1521: ['1521_img0001_-_pro_maxinnku_a_estellku'] }, { dedication: null });
  try {
    const first = await run(f);
    setOrderDedication(first.orders[0].orderDir, ''); // 'this book gets no dedication'

    const builder = new StubBuilder();
    const { orders } = await run(f, { builder, force: true });

    assert.equal(orders[0].status, ORDER_STATUS.DONE, 'it still prints');
    assert.equal(orders[0].titled, false);
    assert.equal(builder.calls[0].options.dedication, undefined, 'the derived text does not come back');
  } finally {
    f.cleanup();
  }
});

test('a configured default title is used when the order has no dedication', async () => {
  const f = fixture({ 1510: ['a'] }, { dedication: null });
  try {
    const builder = new StubBuilder();
    const config = { ...CONFIG, builder: { ...CONFIG.builder, pdf: { title: 'a global default' } } };
    const { orders } = await runPipeline({ config, inboxRoot: f.inbox, outboxRoot: f.outbox, generator: new StubGenerator(), builder, qc: OK_QC, intake: OK_INTAKE });

    assert.equal(orders[0].status, ORDER_STATUS.DONE);
    assert.equal(builder.calls[0].options.title, 'a global default');
  } finally {
    f.cleanup();
  }
});

test('changing the dedication reprints the book', async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    const first = await run(f);
    const { orderDir } = first.orders[0];
    assert.equal(first.orders[0].status, ORDER_STATUS.DONE, 'the seeded dedication printed a book');

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
    await runPipeline({ config, inboxRoot: f.inbox, outboxRoot: f.outbox, generator: new StubGenerator(), builder, qc: OK_QC, intake: OK_INTAKE });

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
    assert.deepEqual(counts, { done: 0, ready: 0, held: 0, failed: 0 });
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
    assert.match(orders[0].reason, /builder seam \(load\): 1 fotek nemá spárovanou omalovánku/);
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

// ---- running only the orders the operator ticked -----------------------------

test('a run works through only the ticked orders, one after another', async () => {
  const f = fixture({ 1510: ['a'], 1523: ['b'], 1479: ['c'] });
  try {
    const builder = new StubBuilder();
    const generator = new StubGenerator();
    const { orders, counts } = await runPipeline({
      config: CONFIG,
      inboxRoot: f.inbox,
      outboxRoot: f.outbox,
      generator,
      builder,
      qc: OK_QC,
      intake: OK_INTAKE,
      only: ['1510', '1479'],
    });

    // The folder's own order, not the order they were ticked in — the run walks the inbox.
    assert.deepEqual(orders.map((o) => o.orderId).sort(), ['1479', '1510']);
    assert.deepEqual(counts, { done: 2, ready: 0, held: 0, failed: 0 });
    assert.deepEqual(generator.calls.sort(), ['a', 'c'], "1523's photo never reached the GPU");
    assert.equal(builder.calls.length, 2);
  } finally {
    f.cleanup();
  }
});

test('the run says how many orders it left alone', async () => {
  const f = fixture({ 1510: ['a'], 1523: ['b'] });
  try {
    const lines = [];
    await runPipeline({
      config: CONFIG,
      inboxRoot: f.inbox,
      outboxRoot: f.outbox,
      generator: new StubGenerator(),
      builder: new StubBuilder(),
      qc: OK_QC,
      intake: OK_INTAKE,
      only: ['1510'],
      onEvent: (e) => lines.push(formatEvent(e)),
    });
    assert.match(lines[0], /1 objednávek.*1 dalších jste nezaškrtli/);
  } finally {
    f.cleanup();
  }
});

test('ticking nothing is not the same as ticking everything', async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    const builder = new StubBuilder();
    const { counts } = await runPipeline({
      config: CONFIG, inboxRoot: f.inbox, outboxRoot: f.outbox,
      generator: new StubGenerator(), builder, qc: OK_QC, intake: OK_INTAKE, only: [],
    });
    assert.deepEqual(counts, { done: 0, ready: 0, held: 0, failed: 0 });
    assert.equal(builder.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

// ---- Stop -----------------------------------------------------------------

test('Stop between orders leaves the ones not yet started untouched, and says so', async () => {
  const f = fixture({ 1510: ['a'], 1523: ['b'], 1540: ['c'] });
  try {
    const controller = new AbortController();
    const generator = new StoppingGenerator(controller, 'a'); // stop the moment 1510 is done
    const builder = new StubBuilder();
    const events = [];
    const { orders, counts, stopped } = await run(f, { generator, builder, signal: controller.signal, onEvent: (e) => events.push(e) });

    assert.equal(stopped, true);
    assert.deepEqual(orders.map((o) => o.orderId), ['1510'], 'only the order that had already run is in the report');
    assert.equal(orders[0].status, ORDER_STATUS.DONE, 'and it finished cleanly — a stop is not a failure');
    assert.deepEqual(generator.calls, ['a'], '1523 and 1540 were never generated');
    assert.equal(builder.calls.length, 1, 'only the finished order reached the builder');
    assert.equal(counts.done, 1);

    const stop = events.find((e) => e.type === 'run-stopped');
    assert.ok(stop, 'a run-stopped event is emitted');
    assert.equal(stop.ran, 1);
    assert.equal(stop.total, 3);
    assert.match(formatEvent(stop), /Zastaveno — 1 z 3 objednávek hotovo/);
  } finally {
    f.cleanup();
  }
});

test('Stop mid-order keeps the photos already made and holds the rest for the next Go', async () => {
  const f = fixture({ 1510: ['a', 'b', 'c'] });
  try {
    const controller = new AbortController();
    const generator = new StoppingGenerator(controller, 'a'); // stop after the first of three photos
    const builder = new StubBuilder();
    const { orders, stopped } = await run(f, { generator, builder, signal: controller.signal });

    assert.equal(stopped, true);
    assert.deepEqual(generator.calls, ['a'], 'b and c were never started');
    assert.equal(orders[0].status, ORDER_STATUS.HELD, 'a half-generated order is held, not shipped');
    assert.equal(orders[0].pdfPath, null, 'and no partial book is built');
    assert.equal(builder.calls.length, 0);

    const m = readManifest(orders[0].orderDir);
    assert.equal(getStatus(m, 'a'), STATES.OK, 'the photo that ran is kept');
    assert.equal(getStatus(m, 'b'), null, 'the untouched photos stay pending');
    assert.equal(getStatus(m, 'c'), null);
  } finally {
    f.cleanup();
  }
});

test('Stop is resumable: a second Go with no signal finishes what was left', async () => {
  const f = fixture({ 1510: ['a', 'b', 'c'] });
  try {
    const controller = new AbortController();
    await run(f, { generator: new StoppingGenerator(controller, 'a'), builder: new StubBuilder(), signal: controller.signal });

    // Nothing cancels this time.
    const generator = new StubGenerator();
    const builder = new StubBuilder();
    const { orders, counts, stopped } = await run(f, { generator, builder });

    assert.ok(!stopped, 'the resumed run was not itself stopped');
    assert.deepEqual(generator.calls.sort(), ['b', 'c'], 'only the photos that had not run are generated');
    assert.equal(orders[0].status, ORDER_STATUS.DONE);
    assert.ok(existsSync(orders[0].pdfPath), 'and now the book is built');
    assert.equal(counts.done, 1);
  } finally {
    f.cleanup();
  }
});

test('a run that is never stopped does not report itself stopped', async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    const { stopped } = await run(f, { signal: new AbortController().signal });
    assert.ok(!stopped);
  } finally {
    f.cleanup();
  }
});

// ---- the intake gate -------------------------------------------------------

test('an order held at intake is not generated, and a draft email is written', async () => {
  const f = fixture({ 1510: ['a'] }, { dedication: null });
  try {
    const generator = new StubGenerator();
    const builder = new StubBuilder();
    const { orders, counts } = await run(f, { generator, builder, intake: holdIntake() });

    assert.equal(orders[0].status, ORDER_STATUS.HELD);
    assert.equal(orders[0].pdfPath, null);
    assert.deepEqual(generator.calls, [], 'nothing reached the GPU');
    assert.equal(builder.calls.length, 0);
    assert.deepEqual(counts, { done: 0, ready: 0, held: 1, failed: 0 });

    const draft = join(orders[0].orderDir, 'draft-email.txt');
    assert.ok(existsSync(draft), 'a copy-paste email is left beside the order');
    const text = readFileSync(draft, 'utf8');
    assert.match(text, /objednávka 1510/);
    assert.match(text, /8 fotek/);
    assert.match(text, /odpovědí na tento e-mail s fotkou v příloze/);

    const intake = readManifest(orders[0].orderDir).intake;
    assert.equal(intake.verdict, 'hold');
    assert.equal(intake.override, false);
  } finally {
    f.cleanup();
  }
});

test('"generate it anyway" clears the hold on the next run', async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    const first = await run(f, { intake: holdIntake() });
    assert.equal(first.orders[0].status, ORDER_STATUS.HELD);

    // A missing-photos hold demands the typed reduced page count (5 of 8 present).
    overrideIntake(first.orders[0].orderDir, { confirmCount: 5 });

    const generator = new StubGenerator();
    const builder = new StubBuilder();
    const { orders } = await run(f, { generator, builder, intake: holdIntake() });

    assert.equal(orders[0].status, ORDER_STATUS.DONE, 'the override lets it through despite the hold');
    assert.deepEqual(generator.calls, ['a']);
    assert.ok(existsSync(orders[0].pdfPath));
  } finally {
    f.cleanup();
  }
});

test('overriding a missing-photos hold needs the typed page count and stamps a permanent flag (N2)', async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    const { orderDir } = (await run(f, { intake: holdIntake() })).orders[0]; // holds: 5 of 8, 3 missing

    // Wrong count (or none) is refused, and the hold still stands.
    assert.throws(() => overrideIntake(orderDir, { confirmCount: 8 }), /Neúplná kniha/);
    assert.throws(() => overrideIntake(orderDir), /Neúplná kniha/);
    assert.equal(readManifest(orderDir).intake.override, false);
    assert.equal(readManifest(orderDir).intake.incompleteBook, undefined);

    // The right count (photos actually present) lets it through and records the flag for good.
    const res = overrideIntake(orderDir, { confirmCount: 5 });
    assert.equal(res.override, true);
    assert.deepEqual({ pages: res.incompleteBook.pages, expected: res.incompleteBook.expected }, { pages: 5, expected: 8 });
    assert.equal(readManifest(orderDir).intake.incompleteBook.pages, 5);
  } finally {
    f.cleanup();
  }
});

test('a hold that lifts on its own clears the stale block and its draft email, and the book prints', async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    // First run: intake holds it, storing a hold verdict and a draft email beside the order.
    const first = await run(f, { intake: holdIntake() });
    const { orderDir } = first.orders[0];
    assert.equal(first.orders[0].status, ORDER_STATUS.HELD);
    assert.ok(existsSync(join(orderDir, 'draft-email.txt')), 'the hold leaves a draft email');
    assert.equal(readManifest(orderDir).intake.verdict, 'hold');

    // The customer sent the missing photos: the next run's intake passes on its own — no override,
    // no force. The lingering hold must not keep a now-buildable order reading held.
    const generator = new StubGenerator();
    const builder = new StubBuilder();
    const { orders } = await run(f, { generator, builder, intake: OK_INTAKE });

    assert.equal(orders[0].status, ORDER_STATUS.DONE, 'the recovered order builds');
    assert.ok(existsSync(orders[0].pdfPath));
    assert.equal(getIntake(readManifest(orderDir)), null, 'the stale hold block is cleared');
    assert.ok(!existsSync(join(orderDir, 'draft-email.txt')), 'and its draft email is removed');
  } finally {
    f.cleanup();
  }
});

test('force bypasses an intake hold', async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    const generator = new StubGenerator();
    const { orders } = await run(f, { generator, intake: holdIntake(), force: true });
    assert.equal(orders[0].status, ORDER_STATUS.DONE);
    assert.deepEqual(generator.calls, ['a']);
  } finally {
    f.cleanup();
  }
});

test('a held order says so in the run log', async () => {
  const f = fixture({ 1510: ['a'] });
  try {
    const lines = [];
    await run(f, { intake: holdIntake(), onEvent: (e) => lines.push(formatEvent(e)) });
    assert.ok(lines.some((l) => l && /vstupní kontrola/.test(l)), `expected an intake line, got: ${lines.filter(Boolean).join(' | ')}`);
  } finally {
    f.cleanup();
  }
});
