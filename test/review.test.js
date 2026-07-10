import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { reviewState, approve, reject, handoff, acceptReplacement, redo, setOrderDedication, applyPhotoEdit, revertPhotoEdit, editBackupPath, ReviewError } from '../src/review.js';
import { STATES, readManifest, getStatus, setStatus, setDedication, writeManifest, emptyManifest, isBuilderEligible } from '../src/manifest.js';
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

// ---- an emptied dedication is recoverable -----------------------------------

test('clearing a dedication remembers what it was, and setting one forgets the undo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-undo-'));
  try {
    writeManifest(dir, setDedication(emptyManifest('1523'), 'Hofbauerovi 18.7.2026'));

    assert.equal(setOrderDedication(dir, ''), '');
    assert.equal(readManifest(dir).dedicationWas, 'Hofbauerovi 18.7.2026', 'the customer text survives the clear');

    assert.equal(setOrderDedication(dir, 'Hofbauerovi 18.7.2026'), 'Hofbauerovi 18.7.2026');
    assert.equal(readManifest(dir).dedicationWas, undefined, 'restoring drops the undo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearing an already-empty dedication records nothing to undo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-undo2-'));
  try {
    writeManifest(dir, emptyManifest('1479'));
    setOrderDedication(dir, '');
    assert.equal(readManifest(dir).dedicationWas, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- fixing a page by hand --------------------------------------------------

const EDIT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80">
<rect x="0" y="0" width="100" height="80" fill="#FFFFFF"/>
<rect x="10" y="30" width="80" height="20" fill="#010101"/>
</svg>`;

async function editableOrder() {
  const dir = mkdtempSync(join(tmpdir(), 'fma-edit-'));
  const orderDir = join(dir, '1510');
  mkdirSync(orderDir, { recursive: true });
  writeFileSync(join(orderDir, 'a.svg'), EDIT_SVG);
  await sharp(Buffer.from(EDIT_SVG)).png().toFile(join(orderDir, 'a_bw.png'));
  await sharp({ create: { width: 100, height: 80, channels: 3, background: '#ccc' } }).jpeg().toFile(join(orderDir, 'a.jpg'));
  writeManifest(orderDir, setStatus(emptyManifest('1510'), 'a', STATES.OK, 'ok'));
  return { dir, orderDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const okQc = async () => ({ verdict: 'ok', reason: 'ok' });
const inkOf = async (png) => {
  const { data } = await sharp(png).flatten({ background: '#ffffff' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return data.reduce((n, v) => n + (v < 128 ? 1 : 0), 0) / data.length;
};

test('the white pencil edits the SVG the book prints, and the PNG is remade from it', async () => {
  const f = await editableOrder();
  try {
    const before = await inkOf(join(f.orderDir, 'a_bw.png'));
    assert.ok(before > 0.1, 'the fixture starts with a black bar');

    // Paint straight across the black bar.
    await applyPhotoEdit({
      orderDir: f.orderDir,
      base: 'a',
      edits: { strokes: [{ width: 30, points: [[0, 40], [100, 40]] }] },
      qc: okQc,
    });

    const svg = readFileSync(join(f.orderDir, 'a.svg'), 'utf8');
    assert.match(svg, /fma-edit/, 'the vector page carries the fix');

    const after = await inkOf(join(f.orderDir, 'a_bw.png'));
    assert.ok(after < before / 2, `the raster was remade from it (${before.toFixed(3)} -> ${after.toFixed(3)})`);
  } finally {
    f.cleanup();
  }
});

test('an edit lands in the review queue, never straight into the book', async () => {
  const f = await editableOrder();
  try {
    const { status } = await applyPhotoEdit({
      orderDir: f.orderDir, base: 'a', edits: { strokes: [{ width: 5, points: [[1, 1], [2, 2]] }] }, qc: okQc,
    });
    assert.equal(status, STATES.PENDING_REVIEW);
    assert.equal(isBuilderEligible(status), false, 'a hand-fixed page still has to be approved');
  } finally {
    f.cleanup();
  }
});

test('cropping changes the page shape, and the raster follows it', async () => {
  const f = await editableOrder();
  try {
    await applyPhotoEdit({ orderDir: f.orderDir, base: 'a', edits: { crop: { x: 0, y: 0, w: 50, h: 80 } }, qc: okQc });
    const meta = await sharp(readFileSync(join(f.orderDir, 'a_bw.png'))).metadata();
    // A rasteriser rounds to whole pixels, so 100x159 is the cropped shape, not a bug.
    assert.ok(Math.abs(meta.width / meta.height - 50 / 80) < 0.01, `aspect ${meta.width}x${meta.height}`);
    assert.match(readFileSync(join(f.orderDir, 'a.svg'), 'utf8'), /viewBox="0 0 50 80"/);
  } finally {
    f.cleanup();
  }
});

test('the generated page is kept, outside the folder the builder is handed', async () => {
  const f = await editableOrder();
  try {
    await applyPhotoEdit({ orderDir: f.orderDir, base: 'a', edits: { strokes: [{ width: 9, points: [[5, 40]] }] }, qc: okQc });
    const backup = editBackupPath(f.orderDir, 'a');
    assert.ok(existsSync(backup));
    assert.equal(readFileSync(backup, 'utf8'), EDIT_SVG, 'byte for byte, as the generator made it');
    assert.ok(!backup.startsWith(f.orderDir), 'a spare SVG in the order folder is one the builder would try to print');
  } finally {
    f.cleanup();
  }
});

test('reverting puts the generated page back and re-renders its raster', async () => {
  const f = await editableOrder();
  try {
    await applyPhotoEdit({ orderDir: f.orderDir, base: 'a', edits: { crop: { x: 0, y: 0, w: 50, h: 80 } }, qc: okQc });
    const { status } = await revertPhotoEdit({ orderDir: f.orderDir, base: 'a', qc: okQc });

    assert.equal(status, STATES.PENDING_REVIEW);
    assert.equal(readFileSync(join(f.orderDir, 'a.svg'), 'utf8'), EDIT_SVG);
    const meta = await sharp(readFileSync(join(f.orderDir, 'a_bw.png'))).metadata();
    assert.ok(Math.abs(meta.width / meta.height - 100 / 80) < 0.01, `the raster is the whole page again, not the crop stretched (${meta.width}x${meta.height})`);
  } finally {
    f.cleanup();
  }
});

test('reverting a page nobody edited says so, rather than inventing an original', async () => {
  const f = await editableOrder();
  try {
    await assert.rejects(() => revertPhotoEdit({ orderDir: f.orderDir, base: 'a', qc: okQc }), ReviewError);
  } finally {
    f.cleanup();
  }
});

test('a reverted page is no longer an edited page', async () => {
  const f = await editableOrder();
  try {
    await applyPhotoEdit({ orderDir: f.orderDir, base: 'a', edits: { strokes: [{ width: 5, points: [[1, 1]] }] }, qc: okQc });
    assert.ok(existsSync(editBackupPath(f.orderDir, 'a')), 'the generated page was kept');

    await revertPhotoEdit({ orderDir: f.orderDir, base: 'a', qc: okQc });
    // reviewState reads `edited` straight off this file. Left behind, it makes the grid go on
    // calling the page hand-fixed and go on offering to undo an edit that is already undone.
    assert.ok(!existsSync(editBackupPath(f.orderDir, 'a')), 'and cleaned up once it was put back');
  } finally {
    f.cleanup();
  }
});

test('a page edited twice can still be taken back to the generated one', async () => {
  const f = await editableOrder();
  try {
    await applyPhotoEdit({ orderDir: f.orderDir, base: 'a', edits: { strokes: [{ width: 5, points: [[1, 1]] }] }, qc: okQc });
    await applyPhotoEdit({ orderDir: f.orderDir, base: 'a', edits: { crop: { x: 0, y: 0, w: 50, h: 40 } }, qc: okQc });
    // The second edit must not overwrite the backup with the first edit's output.
    await revertPhotoEdit({ orderDir: f.orderDir, base: 'a', qc: okQc });

    assert.equal(readFileSync(join(f.orderDir, 'a.svg'), 'utf8'), EDIT_SVG);
  } finally {
    f.cleanup();
  }
});

test('an edit to a photo with no coloring page is refused, not written', async () => {
  const f = await editableOrder();
  try {
    rmSync(join(f.orderDir, 'a.svg'));
    await assert.rejects(
      () => applyPhotoEdit({ orderDir: f.orderDir, base: 'a', edits: { strokes: [{ width: 5, points: [[1, 1]] }] }, qc: okQc }),
      ReviewError,
    );
  } finally {
    f.cleanup();
  }
});

test('a stroke the browser mangled is refused as an operator-facing message', async () => {
  const f = await editableOrder();
  try {
    await assert.rejects(
      () => applyPhotoEdit({ orderDir: f.orderDir, base: 'a', edits: { strokes: [{ width: 'fat', points: [[1, 1]] }] }, qc: okQc }),
      (err) => err instanceof ReviewError && !/EditError/.test(err.message),
    );
    assert.equal(readFileSync(join(f.orderDir, 'a.svg'), 'utf8'), EDIT_SVG, 'and the page is untouched');
  } finally {
    f.cleanup();
  }
});
