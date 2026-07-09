import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { generateOrder, runBatch, nextAttemptSettings } from '../src/batch.js';
import { GeneratorError } from '../src/generator/driver.js';
import { STATES, readManifest, getStatus, setStatus, writeManifest, emptyManifest } from '../src/manifest.js';
import { photoBase } from '../src/organize.js';

/** A stand-in coloring raster: 1px lines with white paper between them. Half ink, but nothing
 *  filled — a solid black block would trip qc's solid-fill tripwire, and rightly so. */
const LINE_ART = Buffer.alloc(8 * 8, 255);
for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) LINE_ART[y * 8 + x] = 0;
const RAW_8 = { raw: { width: 8, height: 8, channels: 1 } };

const CONFIG = {
  generator: { baseUrl: 'https://example.test/tok', mode: 'api', variant: '2509_1.5', diffusionSteps: 8 },
  builder: { baseUrl: 'https://example.test/builder' },
  paths: { inbox: './inbox', outbox: './outbox' },
};

const OK_QC = async () => ({ verdict: 'ok', reason: 'ok' });
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10"/></svg>';

/** Stands in for the live generator: writes a real triple, so organize + QC run for real. */
class StubDriver {
  constructor({ failOn = [], svg = SVG } = {}) {
    this.failOn = new Set(failOn);
    this.svg = svg;
    this.calls = [];
    this.steps = []; // the diffusionSteps each call was asked for
    this.workDir = mkdtempSync(join(tmpdir(), 'fma-stubgen-'));
  }

  async generate(photoPath, settings = {}) {
    const base = photoBase(photoPath);
    this.calls.push(base);
    this.steps.push(settings.diffusionSteps);
    if (this.failOn.has(base)) {
      throw new GeneratorError('Generation failed on the GPU: worker lost', { step: 'poll' });
    }
    const originalPath = join(this.workDir, `${base}.jpeg`);
    const coloringPngPath = join(this.workDir, `${base}_bw.png`);
    const coloringSvgPath = join(this.workDir, `${base}.svg`);
    writeFileSync(originalPath, 'jpeg-bytes');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toFile(coloringPngPath);
    writeFileSync(coloringSvgPath, this.svg);
    return { originalPath, coloringPngPath, coloringSvgPath };
  }
}

/** `await fn(...)`, not `return fn(...)`: without the await the finally block tore the temp tree
 *  down while the test was still using it, and only writeOutputs' mkdir put it back. */
async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fma-batch-'));
  const inbox = join(root, 'inbox');
  const outbox = join(root, 'outbox');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(outbox, { recursive: true });
  try {
    return await fn({ root, inbox, outbox });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Writes n photos into <inbox>/<orderId> and returns the order model ingest would produce. */
function seedOrder(inbox, orderId, names) {
  const dir = join(inbox, orderId);
  mkdirSync(dir, { recursive: true });
  const photos = names.map((n) => {
    const p = join(dir, n);
    writeFileSync(p, 'photo');
    return p;
  });
  return { orderId, dir, photos };
}

test('a clean photo lands the builder triple and is recorded ok', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = seedOrder(inbox, '1510', ['1510_img0001_-_barca.jpeg']);
    const driver = new StubDriver();
    const { orderDir, summary } = await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver, qc: OK_QC });

    assert.ok(existsSync(join(orderDir, '1510_img0001_-_barca.jpg')), 'original normalized to .jpg');
    assert.ok(existsSync(join(orderDir, '1510_img0001_-_barca_bw.png')));
    assert.ok(existsSync(join(orderDir, '1510_img0001_-_barca.svg')));
    assert.ok(existsSync(join(orderDir, 'state.json')));

    assert.equal(getStatus(readManifest(orderDir), '1510_img0001_-_barca'), STATES.OK);
    assert.deepEqual(summary, { total: 1, eligible: 1, held: 0, manual: 0, failed: 0, pending: 0, ready: true });
  });
});

test('a QC-flagged photo holds for review and records why', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = seedOrder(inbox, '1510', ['a.jpeg']);
    const qc = async () => ({ verdict: 'flagged', reason: 'near-blank' });
    const { orderDir, summary } = await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver: new StubDriver(), qc });

    const manifest = readManifest(orderDir);
    assert.equal(getStatus(manifest, 'a'), STATES.FLAGGED);
    assert.equal(manifest.photos.a.reason, 'near-blank');
    assert.equal(summary.ready, false);
    assert.equal(summary.held, 1);
  });
});

test('re-running skips photos already ok and does not call the generator again', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = seedOrder(inbox, '1510', ['a.jpeg', 'b.jpeg']);
    const first = new StubDriver();
    await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver: first, qc: OK_QC });
    assert.deepEqual(first.calls, ['a', 'b']);

    const second = new StubDriver();
    await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver: second, qc: OK_QC });
    assert.deepEqual(second.calls, [], 'a resumed run does no redundant work');
  });
});

test('re-running regenerates a flagged photo, each time with a changed step count', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = seedOrder(inbox, '1510', ['a.jpeg', 'b.jpeg']);
    let verdict = 'flagged';
    const qc = async () => ({ verdict, reason: verdict === 'ok' ? 'ok' : 'near-blank' });

    const first = new StubDriver();
    await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver: first, qc });
    assert.deepEqual(first.calls, ['a', 'b']);
    assert.deepEqual(first.steps, [8, 8], 'a first attempt runs at the configured step count');

    // Still bad on the second roll: flagged -> flagged is idempotent, not an illegal transition.
    const second = new StubDriver();
    const { summary } = await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver: second, qc });
    assert.deepEqual(second.calls, ['a', 'b']);
    assert.deepEqual(second.steps, [9, 9], 'a re-roll must differ, or this generator repeats itself');
    assert.equal(summary.held, 2);

    // Good on the third: both clear the gate.
    verdict = 'ok';
    const third = new StubDriver();
    const { summary: after } = await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver: third, qc });
    assert.deepEqual(third.calls, ['a', 'b']);
    assert.equal(after.ready, true);
  });
});

test('a resumed run retries a failed photo but never touches one the operator owns', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = seedOrder(inbox, '1510', ['fail.jpeg', 'manual.jpeg', 'pending.jpeg']);
    const orderDir = join(outbox, '1510');
    mkdirSync(orderDir, { recursive: true });
    const m = emptyManifest('1510');
    setStatus(m, 'fail', STATES.FAILED, 'generator seam (poll): worker lost');
    setStatus(m, 'manual', STATES.FLAGGED);
    setStatus(m, 'manual', STATES.MANUAL_IN_PROGRESS);
    setStatus(m, 'pending', STATES.FLAGGED);
    setStatus(m, 'pending', STATES.MANUAL_IN_PROGRESS);
    setStatus(m, 'pending', STATES.PENDING_REVIEW);
    writeManifest(orderDir, m);

    const driver = new StubDriver();
    await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver, qc: OK_QC });

    assert.deepEqual(driver.calls, ['fail'], 'only the failed photo is retried');
    const after = readManifest(orderDir);
    assert.equal(getStatus(after, 'fail'), STATES.OK);
    assert.equal(getStatus(after, 'manual'), STATES.MANUAL_IN_PROGRESS, 'manual repair not clobbered');
    assert.equal(getStatus(after, 'pending'), STATES.PENDING_REVIEW, 'awaiting approval, not regenerated');
  });
});

test('one photo failing is recorded in plain language and the batch continues', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = seedOrder(inbox, '1510', ['a.jpeg', 'bad.jpeg', 'c.jpeg']);
    const driver = new StubDriver({ failOn: ['bad'] });
    const events = [];
    const { orderDir, summary } = await generateOrder({
      config: CONFIG,
      order,
      outboxRoot: outbox,
      driver,
      qc: OK_QC,
      onEvent: (e) => events.push(e),
    });

    assert.deepEqual(driver.calls, ['a', 'bad', 'c'], 'the failure did not abort the order');
    const manifest = readManifest(orderDir);
    assert.equal(getStatus(manifest, 'a'), STATES.OK);
    assert.equal(getStatus(manifest, 'c'), STATES.OK);
    assert.equal(getStatus(manifest, 'bad'), STATES.FAILED);

    const reason = manifest.photos.bad.reason;
    assert.match(reason, /^generator seam \(poll\): Generation failed on the GPU/);
    assert.ok(!reason.includes('    at '), 'no stack trace reaches the operator');

    assert.equal(summary.ready, false);
    assert.equal(summary.failed, 1);
    assert.ok(events.some((e) => e.type === 'photo-failed' && e.base === 'bad'));
  });
});

test('state.json is written after each photo, so an interrupt loses at most one', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = seedOrder(inbox, '1510', ['a.jpeg', 'boom.jpeg']);
    const orderDir = join(outbox, '1510');
    const driver = new StubDriver();
    // Read the on-disk status of 'a' at the moment 'boom' dies. Assert it *after* the run:
    // generateOrder swallows exceptions per photo, so an assert thrown in here would be
    // recorded as a failed photo and never surface.
    let aOnDiskWhenBoomDied = '(boom never ran)';
    const qc = async (out) => {
      if (out.base === 'boom') {
        aOnDiskWhenBoomDied = getStatus(readManifest(orderDir), 'a');
        throw new Error('process died');
      }
      return { verdict: 'ok', reason: 'ok' };
    };
    await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver, qc });

    assert.equal(aOnDiskWhenBoomDied, STATES.OK, 'the first photo was durable before the second ran');
    assert.equal(getStatus(readManifest(orderDir), 'a'), STATES.OK);
    const resumed = new StubDriver();
    await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver: resumed, qc: OK_QC });
    assert.deepEqual(resumed.calls, ['boom']);
  });
});

// ---- the re-roll ladder -----------------------------------------------------
// At >= 8 steps the generator is deterministic and its API takes no seed, so an identical
// re-run returns the identical page. A re-roll has to change the step count or it is theatre.

test('nextAttemptSettings climbs from the last attempt and stops at the ceiling', () => {
  const g = { variant: '2509_1.5', diffusionSteps: 8, maxDiffusionSteps: 10 };
  assert.equal(nextAttemptSettings(g, null).diffusionSteps, 9, 'no attempt yet: one above the configured floor');
  assert.equal(nextAttemptSettings(g, { steps: 8 }).diffusionSteps, 9);
  assert.equal(nextAttemptSettings(g, { steps: 9 }).diffusionSteps, 10);
  assert.equal(nextAttemptSettings(g, { steps: 10 }), null, 'the ceiling is exhausted');
  assert.equal(nextAttemptSettings(g, { steps: 8 }).variant, '2509_1.5', 'everything else is carried over');
});

test('nextAttemptSettings defaults the ceiling when the config omits it', () => {
  assert.equal(nextAttemptSettings({ diffusionSteps: 8 }, { steps: 11 }).diffusionSteps, 12);
  assert.equal(nextAttemptSettings({ diffusionSteps: 8 }, { steps: 12 }), null);
});

test('a photo re-rolled to the ceiling stops calling the generator and says why', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = seedOrder(inbox, '1510', ['a.jpeg']);
    const config = { ...CONFIG, generator: { ...CONFIG.generator, maxDiffusionSteps: 9 } };
    const qc = async () => ({ verdict: 'flagged', reason: 'solid-fill' });

    const first = new StubDriver();
    await generateOrder({ config, order, outboxRoot: outbox, driver: first, qc });
    assert.deepEqual(first.steps, [8]);

    const second = new StubDriver();
    await generateOrder({ config, order, outboxRoot: outbox, driver: second, qc });
    assert.deepEqual(second.steps, [9], 'the last rung');

    const third = new StubDriver();
    const { orderDir, summary } = await generateOrder({ config, order, outboxRoot: outbox, driver: third, qc });
    assert.deepEqual(third.calls, [], 'no GPU minute burned reprinting the same defect');
    assert.equal(summary.held, 1, 'and it still holds the order');
    const manifest = readManifest(orderDir);
    assert.equal(getStatus(manifest, 'a'), STATES.FLAGGED);
    assert.match(manifest.photos.a.reason, /ceiling/);
    assert.match(manifest.photos.a.reason, /repair it by hand/);
  });
});

test('a photo that failed to generate retries at the same step count, not the next rung', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = seedOrder(inbox, '1510', ['a.jpeg']);
    // A lost GPU job produced no page, so there is nothing for a re-roll to differ from.
    const failing = new StubDriver({ failOn: ['a'] });
    await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver: failing, qc: OK_QC });
    assert.deepEqual(failing.steps, [8]);

    const retry = new StubDriver();
    const { orderDir } = await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver: retry, qc: OK_QC });
    assert.deepEqual(retry.steps, [8], 'a lost worker is not a bad drawing');
    assert.equal(getStatus(readManifest(orderDir), 'a'), STATES.OK);
  });
});

test('the attempt that produced the page on disk is recorded in state.json', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = seedOrder(inbox, '1510', ['a.jpeg']);
    const { orderDir } = await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver: new StubDriver(), qc: OK_QC });
    assert.deepEqual(readManifest(orderDir).photos.a.attempt, { steps: 8, variant: '2509_1.5' });
  });
});

test('the real QC adapter flags a blank render and passes an inked one', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = seedOrder(inbox, '1510', ['blank.jpeg']);
    const blank = new StubDriver(); // its stub PNG is all white
    const { orderDir } = await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver: blank });
    const manifest = readManifest(orderDir);
    assert.equal(getStatus(manifest, 'blank'), STATES.FLAGGED);
    assert.equal(manifest.photos.blank.reason, 'near-blank');

    // Same pipeline, but the render carries ink: line art, half the pixels black.
    const inked = new StubDriver();
    inked.generate = async (photoPath) => {
      const base = photoBase(photoPath);
      const res = await StubDriver.prototype.generate.call(inked, photoPath);
      await sharp(LINE_ART, RAW_8).png().toFile(join(inked.workDir, `${base}_bw.png`));
      return res;
    };
    const order2 = seedOrder(inbox, '1511', ['inked.jpeg']);
    const { orderDir: dir2 } = await generateOrder({ config: CONFIG, order: order2, outboxRoot: outbox, driver: inked });
    assert.equal(getStatus(readManifest(dir2), 'inked'), STATES.OK);
  });
});

test('an SVG with no drawing elements is flagged, however inked the raster looks', async () => {
  await fixture(async ({ inbox, outbox }) => {
    const order = seedOrder(inbox, '1510', ['a.jpeg']);
    const driver = new StubDriver({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
    const { orderDir } = await generateOrder({ config: CONFIG, order, outboxRoot: outbox, driver });
    assert.equal(readManifest(orderDir).photos.a.reason, 'no-paths');
  });
});

test('runBatch walks every order in the inbox into its own output folder', async () => {
  await fixture(async ({ inbox, outbox }) => {
    seedOrder(inbox, '1510', ['1510_img0001_-_a.jpeg']);
    seedOrder(inbox, '1523', ['1523_img0001_-_b.jpeg', '1523_img0002_-_c.jpeg']);
    const driver = new StubDriver();
    const report = await runBatch({ config: CONFIG, inboxRoot: inbox, outboxRoot: outbox, driver, qc: OK_QC });

    assert.deepEqual(report.orders.map((o) => o.orderId), ['1510', '1523']);
    assert.ok(report.orders.every((o) => o.summary.ready));
    assert.ok(existsSync(join(outbox, '1510', '1510_img0001_-_a.svg')));
    assert.ok(existsSync(join(outbox, '1523', '1523_img0002_-_c.svg')));
    assert.equal(driver.calls.length, 3);
  });
});
