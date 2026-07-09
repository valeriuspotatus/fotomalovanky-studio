import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { reviewState, approve, reject, handoff, acceptReplacement, redo, ReviewError } from '../src/review.js';
import { STATES, readManifest, getStatus, setStatus, writeManifest, emptyManifest, isBuilderEligible } from '../src/manifest.js';
import { photoBase } from '../src/organize.js';
import { GeneratorError } from '../src/generator/driver.js';

const CONFIG = {
  generator: { baseUrl: 'https://example.test/tok', mode: 'api', variant: '2509_1.5', diffusionSteps: 8 },
  builder: { baseUrl: 'https://example.test/builder' },
  paths: { inbox: './inbox', outbox: './outbox' },
};

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10"/></svg>';
const OK_QC = async () => ({ verdict: 'ok', reason: 'ok' });
const BAD_QC = async () => ({ verdict: 'flagged', reason: 'near-blank' });

/** Line art — 1px lines with white paper between them. Real ink, so the real QC adapter passes
 *  it; nothing is filled, so it does not trip the solid-fill tripwire either. */
const LINE_ART = Buffer.alloc(8 * 8, 255);
for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) LINE_ART[y * 8 + x] = 0;

const inkedPng = (dest) => sharp(LINE_ART, { raw: { width: 8, height: 8, channels: 1 } }).png().toFile(dest);

class StubDriver {
  constructor({ fail = false } = {}) {
    this.fail = fail;
    this.calls = [];
    this.workDir = mkdtempSync(join(tmpdir(), 'fma-stubgen-'));
  }
  async generate(photoPath) {
    this.calls.push(photoPath);
    if (this.fail) throw new GeneratorError('Generation failed on the GPU: worker lost', { step: 'poll' });
    const base = photoBase(photoPath);
    const originalPath = join(this.workDir, `${base}.jpeg`);
    const coloringPngPath = join(this.workDir, `${base}_bw.png`);
    const coloringSvgPath = join(this.workDir, `${base}.svg`);
    writeFileSync(originalPath, 'jpeg-bytes');
    await inkedPng(coloringPngPath);
    writeFileSync(coloringSvgPath, SVG);
    return { originalPath, coloringPngPath, coloringSvgPath };
  }
}

/** An outbox order folder holding one photo's triple plus a manifest at `status`. */
async function seed(status, { reason = null, base = 'a', withOutputs = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fma-review-'));
  const inbox = join(root, 'inbox', '1510');
  const outbox = join(root, 'outbox');
  const orderDir = join(outbox, '1510');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(orderDir, { recursive: true });

  const sourcePath = join(inbox, `${base}.jpeg`);
  writeFileSync(sourcePath, 'photo');

  if (withOutputs) {
    writeFileSync(join(orderDir, `${base}.jpg`), 'jpeg-bytes');
    writeFileSync(join(orderDir, `${base}.svg`), SVG);
    await inkedPng(join(orderDir, `${base}_bw.png`));
  }

  const m = emptyManifest('1510');
  if (status) {
    // Walk the state machine to reach non-initial states legally.
    const path = {
      [STATES.MANUAL_IN_PROGRESS]: [STATES.FLAGGED, STATES.MANUAL_IN_PROGRESS],
      [STATES.PENDING_REVIEW]: [STATES.FLAGGED, STATES.MANUAL_IN_PROGRESS, STATES.PENDING_REVIEW],
      [STATES.APPROVED]: [STATES.OK, STATES.APPROVED],
    }[status] ?? [status];
    for (const s of path) setStatus(m, base, s, s === status ? reason : null);
    m.photos[base].source = sourcePath;
  }
  writeManifest(orderDir, m);
  return { root, inbox: join(root, 'inbox'), outbox, orderDir, base, sourcePath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ---- the approval policy ---------------------------------------------------

test('a clean photo is builder-eligible with no operator action', async () => {
  const f = await seed(STATES.OK, { reason: 'ok' });
  try {
    const [order] = reviewState({ inboxRoot: f.inbox, outboxRoot: f.outbox });
    assert.equal(order.photos[0].status, STATES.OK);
    assert.ok(order.photos[0].builderEligible);
    assert.equal(order.summary.ready, true);
  } finally {
    f.cleanup();
  }
});

test('a flagged photo is never builder-eligible until it is explicitly approved', async () => {
  const f = await seed(STATES.FLAGGED, { reason: 'near-blank' });
  try {
    let [order] = reviewState({ inboxRoot: f.inbox, outboxRoot: f.outbox });
    assert.ok(!order.photos[0].builderEligible);
    assert.ok(order.photos[0].holdsForReview);
    assert.equal(order.summary.ready, false);

    assert.equal(approve(f.orderDir, 'a'), STATES.APPROVED);
    [order] = reviewState({ inboxRoot: f.inbox, outboxRoot: f.outbox });
    assert.ok(order.photos[0].builderEligible);
    assert.equal(order.summary.ready, true);
  } finally {
    f.cleanup();
  }
});

test('a verdict is persisted to state.json and survives a restart', async () => {
  const f = await seed(STATES.FLAGGED, { reason: 'near-blank' });
  try {
    approve(f.orderDir, 'a');
    // Nothing cached: read the file back from scratch, as a relaunched tool would.
    const manifest = readManifest(f.orderDir);
    assert.equal(getStatus(manifest, 'a'), STATES.APPROVED);
    assert.equal(manifest.photos.a.reason, 'operator approved');
    assert.ok(isBuilderEligible(getStatus(manifest, 'a')));
  } finally {
    f.cleanup();
  }
});

test('the operator can overrule a clean verdict, and the photo leaves the builder gate', async () => {
  const f = await seed(STATES.OK, { reason: 'ok' });
  try {
    assert.equal(reject(f.orderDir, 'a'), STATES.FLAGGED);
    const manifest = readManifest(f.orderDir);
    assert.equal(manifest.photos.a.reason, 'operator marked bad');
    assert.ok(!isBuilderEligible(getStatus(manifest, 'a')));
  } finally {
    f.cleanup();
  }
});

test('approving a photo that never generated is refused with a plain-language reason', async () => {
  const f = await seed(STATES.FAILED, { reason: 'generator seam (poll): worker lost' });
  try {
    assert.throws(() => approve(f.orderDir, 'a'), (err) => {
      assert.ok(err instanceof ReviewError);
      assert.match(err.message, /never generated/);
      return true;
    });
    assert.equal(getStatus(readManifest(f.orderDir), 'a'), STATES.FAILED);
  } finally {
    f.cleanup();
  }
});

// ---- redo ------------------------------------------------------------------

test('a redo re-generates and a clean result auto-advances to ok', async () => {
  const f = await seed(STATES.FLAGGED, { reason: 'near-blank' });
  try {
    const driver = new StubDriver();
    const status = await redo({ config: CONFIG, orderDir: f.orderDir, base: 'a', driver, qc: OK_QC });
    assert.equal(status, STATES.OK);
    assert.deepEqual(driver.calls, [f.sourcePath], 'regenerated from the operator original, not the echoed copy');
    assert.ok(isBuilderEligible(getStatus(readManifest(f.orderDir), 'a')));
  } finally {
    f.cleanup();
  }
});

test('a redo that comes back just as bad stays flagged, and stays out of the builder', async () => {
  const f = await seed(STATES.FLAGGED, { reason: 'near-blank' });
  try {
    const status = await redo({ config: CONFIG, orderDir: f.orderDir, base: 'a', driver: new StubDriver(), qc: BAD_QC });
    assert.equal(status, STATES.FLAGGED);
    assert.ok(!isBuilderEligible(status));
  } finally {
    f.cleanup();
  }
});

test('a redo of an approved photo passes back through flagged first', async () => {
  const f = await seed(STATES.APPROVED);
  try {
    // approved -> ok is not a legal transition. Only the flagged pass-through makes a clean
    // redo land on ok; without it the illegal transition would be recorded as a failure.
    const status = await redo({ config: CONFIG, orderDir: f.orderDir, base: 'a', driver: new StubDriver(), qc: OK_QC });
    assert.equal(status, STATES.OK);
  } finally {
    f.cleanup();
  }
});

test('a redo of an approved photo that comes back bad revokes the approval', async () => {
  const f = await seed(STATES.APPROVED);
  try {
    const status = await redo({ config: CONFIG, orderDir: f.orderDir, base: 'a', driver: new StubDriver(), qc: BAD_QC });
    assert.equal(status, STATES.FLAGGED);
    assert.ok(!isBuilderEligible(status), 'a photo the operator once approved must not stay eligible');
  } finally {
    f.cleanup();
  }
});

test('a redo of a failed photo is allowed, and a failing redo records the seam not a stack', async () => {
  const f = await seed(STATES.FAILED, { reason: 'generator seam (poll): worker lost' });
  try {
    const status = await redo({ config: CONFIG, orderDir: f.orderDir, base: 'a', driver: new StubDriver({ fail: true }), qc: OK_QC });
    assert.equal(status, STATES.FAILED);
    const reason = readManifest(f.orderDir).photos.a.reason;
    assert.match(reason, /^generator seam \(poll\)/);
    assert.ok(!reason.includes('    at '));
  } finally {
    f.cleanup();
  }
});

test('a redo falls back to the order folder when the original photo has been purged', async () => {
  const f = await seed(STATES.FLAGGED, { reason: 'near-blank' });
  try {
    rmSync(f.sourcePath); // the 30-day retention purge already ran
    const driver = new StubDriver();
    const status = await redo({ config: CONFIG, orderDir: f.orderDir, base: 'a', driver, qc: OK_QC });
    assert.equal(status, STATES.OK);
    assert.deepEqual(driver.calls, [join(f.orderDir, 'a.jpg')]);
  } finally {
    f.cleanup();
  }
});

test('a redo with no photo left anywhere fails loudly instead of guessing', async () => {
  const f = await seed(STATES.FLAGGED, { reason: 'near-blank' });
  try {
    rmSync(f.sourcePath);
    rmSync(join(f.orderDir, 'a.jpg'));
    await assert.rejects(
      () => redo({ config: CONFIG, orderDir: f.orderDir, base: 'a', driver: new StubDriver(), qc: OK_QC }),
      (err) => err instanceof ReviewError && /Cannot redo/.test(err.message),
    );
  } finally {
    f.cleanup();
  }
});

// ---- manual handoff --------------------------------------------------------

test('a handoff sets manual_in_progress, and approval is refused until the replacement lands', async () => {
  const f = await seed(STATES.FLAGGED, { reason: 'near-blank' });
  try {
    assert.equal(handoff(f.orderDir, 'a'), STATES.MANUAL_IN_PROGRESS);
    assert.throws(() => approve(f.orderDir, 'a'), (err) => {
      assert.match(err.message, /out for manual repair/);
      return err instanceof ReviewError;
    });
    assert.equal(getStatus(readManifest(f.orderDir), 'a'), STATES.MANUAL_IN_PROGRESS);
  } finally {
    f.cleanup();
  }
});

test('handing off a clean photo records the rejection on the way through', async () => {
  const f = await seed(STATES.OK, { reason: 'ok' });
  try {
    assert.equal(handoff(f.orderDir, 'a'), STATES.MANUAL_IN_PROGRESS);
  } finally {
    f.cleanup();
  }
});

test('a replacement re-runs QC, re-enters review as pending_review, and never auto-approves', async () => {
  const f = await seed(STATES.MANUAL_IN_PROGRESS);
  try {
    const { status, verdict } = await acceptReplacement({ orderDir: f.orderDir, base: 'a', qc: OK_QC });
    assert.equal(status, STATES.PENDING_REVIEW);
    assert.equal(verdict.verdict, 'ok');
    // Clean QC is not consent: it still holds for review.
    assert.ok(!isBuilderEligible(status));
    assert.ok(reviewState({ inboxRoot: f.inbox, outboxRoot: f.outbox })[0].photos[0].holdsForReview);

    assert.equal(approve(f.orderDir, 'a'), STATES.APPROVED);
  } finally {
    f.cleanup();
  }
});

test('a still-degenerate replacement re-enters review, carrying the QC reason', async () => {
  const f = await seed(STATES.MANUAL_IN_PROGRESS);
  try {
    const { status } = await acceptReplacement({ orderDir: f.orderDir, base: 'a', qc: BAD_QC });
    assert.equal(status, STATES.PENDING_REVIEW);
    assert.equal(readManifest(f.orderDir).photos.a.reason, 'near-blank');
  } finally {
    f.cleanup();
  }
});

test('clicking "I have replaced it" without replacing anything is refused', async () => {
  const f = await seed(STATES.MANUAL_IN_PROGRESS);
  try {
    rmSync(join(f.orderDir, 'a.svg'));
    await assert.rejects(
      () => acceptReplacement({ orderDir: f.orderDir, base: 'a', qc: OK_QC }),
      (err) => err instanceof ReviewError && /No replacement found/.test(err.message),
    );
    assert.equal(getStatus(readManifest(f.orderDir), 'a'), STATES.MANUAL_IN_PROGRESS, 'still out for repair');
  } finally {
    f.cleanup();
  }
});

test('a replacement can only be accepted for a photo that was handed off', async () => {
  const f = await seed(STATES.FLAGGED, { reason: 'near-blank' });
  try {
    await assert.rejects(
      () => acceptReplacement({ orderDir: f.orderDir, base: 'a', qc: OK_QC }),
      (err) => err instanceof ReviewError && /was not handed off/.test(err.message),
    );
  } finally {
    f.cleanup();
  }
});

test('the operator can abandon a manual repair and send the photo back to the generator', async () => {
  const f = await seed(STATES.MANUAL_IN_PROGRESS);
  try {
    const status = await redo({ config: CONFIG, orderDir: f.orderDir, base: 'a', driver: new StubDriver(), qc: OK_QC });
    assert.equal(status, STATES.OK);
  } finally {
    f.cleanup();
  }
});

// ---- the grid's states -----------------------------------------------------

test('reviewState reports an empty grid when there is nothing to review', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-review-'));
  try {
    assert.deepEqual(reviewState({ inboxRoot: join(root, 'inbox'), outboxRoot: join(root, 'outbox') }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a photo the batch has not reached yet is a pending tile, and holds its order back', async () => {
  const f = await seed(STATES.OK, { reason: 'ok' });
  try {
    // A second photo exists in the inbox but has never been generated.
    writeFileSync(join(f.inbox, '1510', 'b.jpeg'), 'photo');
    const [order] = reviewState({ inboxRoot: f.inbox, outboxRoot: f.outbox });

    const b = order.photos.find((p) => p.base === 'b');
    assert.equal(b.status, null, 'no manifest entry yet -> the grid shows "generating…"');
    assert.equal(b.files.coloring, null);
    assert.ok(b.files.original, 'but its input photo is there to show');
    assert.equal(order.summary.pending, 1);
    assert.equal(order.summary.ready, false, 'an order with a photo still to run is not ready');
  } finally {
    f.cleanup();
  }
});

test('an order whose photos were purged still reviews, from the outbox alone', async () => {
  const f = await seed(STATES.FLAGGED, { reason: 'near-blank' });
  try {
    rmSync(join(f.root, 'inbox'), { recursive: true, force: true });
    const [order] = reviewState({ inboxRoot: join(f.root, 'inbox'), outboxRoot: f.outbox });
    assert.equal(order.orderId, '1510');
    assert.equal(order.photos[0].status, STATES.FLAGGED);
    assert.ok(order.photos[0].files.coloring, 'the generated line-art is still there to look at');
    assert.ok(existsSync(order.photos[0].files.original));
  } finally {
    f.cleanup();
  }
});

test('a failed photo surfaces its reason so the tile can explain itself', async () => {
  const f = await seed(STATES.FAILED, { reason: 'generator seam (poll): worker lost' });
  try {
    const [order] = reviewState({ inboxRoot: f.inbox, outboxRoot: f.outbox });
    assert.equal(order.photos[0].status, STATES.FAILED);
    assert.match(order.photos[0].reason, /worker lost/);
    assert.equal(order.summary.failed, 1);
    assert.equal(order.summary.ready, false);
  } finally {
    f.cleanup();
  }
});

test('an unknown photo is rejected rather than silently created', async () => {
  const f = await seed(STATES.OK, { reason: 'ok' });
  try {
    assert.throws(() => approve(f.orderDir, 'nope'), ReviewError);
  } finally {
    f.cleanup();
  }
});
