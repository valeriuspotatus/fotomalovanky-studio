import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import sharp from 'sharp';
import { ingestOrders } from './ingest.js';
import { generatePhoto } from './batch.js';
import { outputPaths, photoBase } from './organize.js';
import { assessOutputFiles } from './qcFiles.js';
import { deriveDedication, deriveSlug } from './dedication.js';
import { readOrderInfo } from './orderInfo.js';
import { recallDedication, learnDedication, MEMORY_DIR } from './dedications.js';
import { applyEdits, EditError } from './editor.js';
import {
  STATES,
  getStatus,
  getSource,
  setStatus,
  getDedication,
  setDedication,
  hasDedication,
  getIntake,
  setIntakeOverride,
  getIntakeOverride,
  getIncompleteBook,
  setIncompleteBook,
  getEmailedAt,
  setEmailedAt,
  readManifest,
  writeManifest,
  summarizeOrder,
  isBuilderEligible,
  holdsForReview,
} from './manifest.js';

// The U4 review gate. state.json is the single source of truth: every verdict here is written
// to disk before the call returns, so closing the tool never loses a decision, and the builder
// gate (isBuilderEligible) reads exactly what the operator saw.
//
// The one rule the whole gate exists to enforce: a flagged photo is NEVER auto-approved.
// Clean results advance on their own; anything the QC tripwire or the operator doubted has to
// be approved by hand before it can reach the PDF.

export class ReviewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReviewError';
    this.seam = 'review';
  }
}

/** Absolute paths to one photo's three files, plus the input photo it came from (if still here). */
export function photoFiles(outboxRoot, orderId, base, sourcePath = null) {
  const orderDir = join(outboxRoot, orderId);
  const out = outputPaths(`${base}.jpg`, orderDir);
  const original = existsSync(out.original) ? out.original : sourcePath && existsSync(sourcePath) ? sourcePath : null;
  return {
    orderDir,
    original,
    coloring: existsSync(out.coloringPng) ? out.coloringPng : null,
    svg: existsSync(out.coloringSvg) ? out.coloringSvg : null,
  };
}

/** Join what the inbox says an order contains with what the manifest says happened to it.
 *  Photos the batch has not reached yet appear with a null status — that is the grid's
 *  "generating…" placeholder, and it is why an order with a photo still to run is not ready. */
/** An order the operator deleted from the board carries this marker in its outbox folder. The order
 *  and its files stay on disk (recoverable — delete the marker to restore it), but it no longer shows
 *  anywhere the board is derived from reviewState. Same folder-marker pattern as delivered/printed. */
export const hiddenMarkerPath = (orderDir) => join(orderDir, 'hidden.json');

export function reviewState({ inboxRoot, outboxRoot, only = null, memoryRoot = MEMORY_DIR }) {
  let ingested = [];
  try {
    ingested = inboxRoot ? ingestOrders(inboxRoot) : [];
  } catch {
    ingested = []; // no inbox (photos purged, or the operator only kept the outputs)
  }
  // The operator may have ticked a few orders out of a folder holding hundreds. Filtering here
  // keeps the poll cheap: nothing else walks those folders or reads their manifests.
  if (only) ingested = ingested.filter((o) => only.includes(o.orderId));

  const byId = new Map(ingested.map((o) => [o.orderId, { ...o, inInbox: true }]));

  // Orders that exist only in the outbox still deserve a review page — a finished book whose
  // photos have been purged, or one from a folder the operator has since moved on from. They are
  // not what the operator is working on now, and the grid says so.
  for (const order of outboxOrders(outboxRoot)) if (!byId.has(order.orderId)) byId.set(order.orderId, { ...order, inInbox: false });

  const orders = [];
  for (const [orderId, order] of byId) {
    const orderDir = join(outboxRoot, orderId);
    if (existsSync(hiddenMarkerPath(orderDir))) continue; // the operator deleted it from the board
    const manifest = readManifest(orderDir);
    const sources = new Map((order.photos ?? []).map((p) => [photoBase(p), p]));
    const bases = sources.size > 0 ? [...sources.keys()] : Object.keys(manifest.photos ?? {});

    // Best source first. The shop's own record is the only one that can spell "Pro Jiříčka"; the
    // photo names lost the accents before this tool ever saw them.
    const shopInfo = order.dir ? readOrderInfo(order.dir) : null;
    const fromShop = shopInfo?.dedication ?? '';
    const remembered = fromShop ? '' : recallDedication(memoryRoot, deriveSlug(bases));
    const suggestion = fromShop || remembered || deriveDedication(bases);

    const photos = bases.map((base) => {
      const status = getStatus(manifest, base);
      const files = photoFiles(outboxRoot, orderId, base, sources.get(base) ?? getSource(manifest, base));
      return {
        base,
        status,
        reason: manifest.photos?.[base]?.reason ?? null,
        builderEligible: isBuilderEligible(status),
        holdsForReview: holdsForReview(status),
        edited: existsSync(editBackupPath(orderDir, base)), // the generated page is still recoverable
        files,
      };
    });

    // The pre-generation intake verdict, and the copy-paste email drafted for a held order (only
    // while the hold stands and the operator has not said "generate it anyway").
    const intake = getIntake(manifest);
    const draftPath = join(orderDir, 'draft-email.txt');
    const draftEmail =
      intake && intake.verdict === 'hold' && !intake.override && existsSync(draftPath) ? readFileSync(draftPath, 'utf8') : '';

    orders.push({
      orderId,
      orderDir,
      dirName: order.dirName ?? orderId,
      inInbox: Boolean(order.inInbox),
      intake,
      draftEmail,
      dedication: getDedication(manifest),
      // When the operator last emailed the customer about a hold (N4), so the grid + board can show
      // "čeká na zákazníka od X" and flag orders that have waited too long.
      emailedAt: getEmailedAt(manifest),
      // Only ever a *suggestion* for an untouched order. Once the operator has decided — even
      // by emptying the box — the grid must show their decision, not talk them out of it.
      suggestedDedication: hasDedication(manifest) ? '' : suggestion,
      suggestionRemembered: Boolean(!hasDedication(manifest) && remembered),
      // Where the suggestion came from, so the grid can say whether it needs checking.
      suggestionSource: hasDedication(manifest) || !suggestion ? '' : fromShop ? 'shop' : remembered ? 'memory' : 'filename',
      // What an empty box used to say, so a clear the operator did not mean is one click away.
      clearedDedication: manifest.dedicationWas ?? '',
      // Which book of a purchase this is, and how many copies of it to print. One checkout can hold
      // several books; each is its own folder, and these are what let the board show the parcel they
      // belong to. A folder with no shop record reads as a lone single-copy book.
      purchase: shopInfo?.purchase ?? { orderId, position: 1, of: 1 },
      copies: shopInfo?.copies ?? 1,
      photos,
      summary: summarizeOrder(manifest, bases),
      // The finished book exists on disk. The generator uses this to move a done order out of the
      // working view on its own, so the operator never has to refresh to clear it.
      built: existsSync(join(orderDir, `${orderId} Final.pdf`)),
    });
  }
  return orders.sort((a, b) => a.orderId.localeCompare(b.orderId, 'en', { numeric: true }));
}

function outboxOrders(outboxRoot) {
  if (!existsSync(outboxRoot)) return [];
  return readdirSync(outboxRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(outboxRoot, e.name, 'state.json')))
    .map((e) => ({ orderId: e.name, photos: [] }));
}

/** Set the order's title-page text. Writing it also makes any already-printed PDF stale,
 *  because state.json is the order's "last decided" clock.
 *
 *  Customer text is the one thing here that cannot be regenerated: the photos can be re-run, the
 *  PDF reprinted, but nobody remembers what a stranger wrote. So an emptied dedication is kept
 *  under `dedicationWas`, and the grid offers it back. One real order lost its text to something
 *  we could not reproduce; this is what makes the next one survivable. */
export function setOrderDedication(orderDir, text, { memoryRoot = MEMORY_DIR } = {}) {
  const manifest = readManifest(orderDir);
  const before = getDedication(manifest);
  setDedication(manifest, text);
  const after = getDedication(manifest);

  if (before && !after) manifest.dedicationWas = before;
  else if (after) delete manifest.dedicationWas;

  writeManifest(orderDir, manifest);

  // Whatever they typed is the true spelling of this name. Remember it against the file name's
  // slug so the next customer called Jiříček is not typed out again — and so nobody has to notice
  // that the shop dropped the accents in the first place.
  const slug = deriveSlug(Object.keys(manifest.photos ?? {}));
  if (slug) learnDedication(memoryRoot, slug, after);

  return after;
}

/** "Generate it anyway": clear an intake hold so the next run generates the order despite the
 *  flagged photos. Order-level, like the dedication — the whole order was held, not one photo.
 *
 *  When the hold is that photos are MISSING, an unguarded override would ship a book with fewer
 *  pages than the customer paid for. So that case demands `confirmCount` — the operator has to type
 *  the reduced page count (the number of photos actually present) back to us — and we stamp a
 *  persistent `incompleteBook` flag that follows the order through PDF and send. Quality-only holds
 *  (blur, dark, duplicate) are not under-count and clear with a plain override. */
export function overrideIntake(orderDir, { on = true, confirmCount = null } = {}) {
  const manifest = readManifest(orderDir);
  const under = on
    ? (getIntake(manifest)?.findings ?? []).find((f) => f.check === 'count' && f.verdict === 'hold' && f.missing > 0)
    : null;

  if (under) {
    const pages = under.unique; // photos actually present = the pages this book will have
    if (Number(confirmCount) !== pages) {
      throw new ReviewError(
        `Neúplná kniha: napište ${pages} pro potvrzení, že kniha bude mít ${pages} stran místo ${under.expected}.`,
      );
    }
    setIncompleteBook(manifest, { pages, expected: under.expected });
  }

  setIntakeOverride(manifest, on);
  writeManifest(orderDir, manifest);
  return { override: getIntakeOverride(manifest), incompleteBook: getIncompleteBook(manifest) };
}

/** Record (or clear) that the operator emailed the customer about a held order (N4). Stores the
 *  current time so the queue can age it; `on: false` clears it (emailed by mistake / customer replied). */
export function markCustomerEmailed(orderDir, on = true) {
  const manifest = readManifest(orderDir);
  setEmailedAt(manifest, on ? new Date().toISOString() : null);
  writeManifest(orderDir, manifest);
  return getEmailedAt(manifest);
}

// ---- verdicts -------------------------------------------------------------

function update(orderDir, base, fn) {
  const manifest = readManifest(orderDir);
  if (!manifest.photos?.[base]) throw new ReviewError(`No photo "${base}" in ${orderDir}.`);
  fn(manifest);
  writeManifest(orderDir, manifest);
  return getStatus(manifest, base);
}

/** The operator says this one is good. The only way a flagged photo reaches the builder. */
export function approve(orderDir, base) {
  return update(orderDir, base, (manifest) => {
    const status = getStatus(manifest, base);
    if (status === STATES.MANUAL_IN_PROGRESS) {
      throw new ReviewError(
        `"${base}" is out for manual repair. Save the replacement into the order folder and click "I've replaced it" first.`,
      );
    }
    if (status === STATES.FAILED) {
      throw new ReviewError(`"${base}" never generated, so there is nothing to approve. Redo it first.`);
    }
    setStatus(manifest, base, STATES.APPROVED, 'operator approved');
  });
}

/** The operator's eye overrules the QC tripwire: send a photo back to the review queue. */
export function reject(orderDir, base, reason = 'operator marked bad') {
  return update(orderDir, base, (manifest) => setStatus(manifest, base, STATES.FLAGGED, reason));
}

/** Hand a photo to the generator/Figma for manual repair. Always passes through flagged, so
 *  "hand off" on a clean-looking photo still records that the operator rejected it. */
export function handoff(orderDir, base) {
  return update(orderDir, base, (manifest) => {
    if (getStatus(manifest, base) !== STATES.FLAGGED) {
      setStatus(manifest, base, STATES.FLAGGED, 'operator sent it for manual repair');
    }
    setStatus(manifest, base, STATES.MANUAL_IN_PROGRESS, 'awaiting a hand-repaired replacement');
  });
}

/** The operator saved a repaired file into the order folder. Re-run QC on what actually landed
 *  and put the tile back in the queue as pending_review — a handoff is a redo, not a shortcut
 *  past review, so this never approves and never marks a photo clean. */
export async function acceptReplacement({ orderDir, base, qc = assessOutputFiles }) {
  const manifest = readManifest(orderDir);
  const status = getStatus(manifest, base);
  if (status !== STATES.MANUAL_IN_PROGRESS && status !== STATES.PENDING_REVIEW) {
    throw new ReviewError(`"${base}" was not handed off for manual repair (it is ${status ?? 'not generated'}).`);
  }

  const out = outputPaths(`${base}.jpg`, orderDir);
  if (!existsSync(out.coloringSvg) || !existsSync(out.coloringPng)) {
    throw new ReviewError(
      `No replacement found for "${base}". Save the repaired ${base}.svg and ${base}_bw.png into ${orderDir}, then click again.`,
    );
  }

  const verdict = await qc(out);
  setStatus(manifest, base, STATES.PENDING_REVIEW, verdict.reason);
  writeManifest(orderDir, manifest);
  return { status: STATES.PENDING_REVIEW, verdict };
}

// ---- fixing a page by hand --------------------------------------------------

/** Where the page looked like before the operator first drew on it.
 *
 *  Kept *outside* the order folder: the builder is handed that whole directory, and a spare SVG
 *  sitting in it is one more thing for it to pair up and print. */
export function editBackupPath(orderDir, base) {
  return join(dirname(orderDir), '.originals', basename(orderDir), `${base}.svg`);
}

/** Render the coloring page's SVG to the raster the grid and QC look at.
 *
 *  Decoded from bytes rather than a path: handed a path, libvips keeps the file mapped while it
 *  works, and on Windows the very next line cannot then overwrite it. */
async function rasterize(svgText, width) {
  let img = sharp(Buffer.from(svgText), { density: 96 });
  if (width) img = img.resize({ width }); // keep the resolution the generator gave us
  return img.flatten({ background: '#ffffff' }).png().toBuffer();
}

/** The operator's white pencil and crop, applied to the page the book actually prints.
 *
 *  The SVG is the truth and the PNG is made from it, never the other way round — the builder
 *  ignores `_bw.png` entirely, so a raster-only fix would look right in the grid and print wrong.
 *  Lands in pending_review by the same path a hand-repaired file does: an edit is a repair, not a
 *  shortcut past the review gate. */
export async function applyPhotoEdit({ orderDir, base, edits, qc = assessOutputFiles }) {
  const manifest = readManifest(orderDir);
  const status = getStatus(manifest, base);
  if (status == null) throw new ReviewError(`No photo "${base}" in ${orderDir}.`);

  const out = outputPaths(`${base}.jpg`, orderDir);
  if (!existsSync(out.coloringSvg)) throw new ReviewError(`"${base}" has no coloring page to fix yet — generate it first.`);

  const before = readFileSync(out.coloringSvg, 'utf8');
  let after;
  try {
    after = applyEdits(before, edits);
  } catch (err) {
    if (err instanceof EditError) throw new ReviewError(err.message);
    throw err;
  }

  // Render before writing anything: an SVG that will not rasterize must not reach the order
  // folder, where the next run would hand it straight to the builder.
  const width = (await sharp(readFileSync(out.coloringPng)).metadata()).width;
  const png = await rasterize(after, width);

  const backup = editBackupPath(orderDir, base);
  if (!existsSync(backup)) {
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(backup, before); // the generated page, before anyone drew on it
  }

  writeFileSync(out.coloringSvg, after);
  writeFileSync(out.coloringPng, png);

  if (status !== STATES.MANUAL_IN_PROGRESS && status !== STATES.PENDING_REVIEW) handoff(orderDir, base);
  return acceptReplacement({ orderDir, base, qc });
}

/** Throw away every edit and put the generated page back. */
export async function revertPhotoEdit({ orderDir, base, qc = assessOutputFiles }) {
  const backup = editBackupPath(orderDir, base);
  if (!existsSync(backup)) throw new ReviewError(`"${base}" has never been edited, so there is nothing to undo.`);

  const out = outputPaths(`${base}.jpg`, orderDir);
  const original = readFileSync(backup, 'utf8');
  // At its own size, not the current PNG's: a crop changed the page's shape, and matching the
  // cropped raster's width would stretch the page we are putting back.
  const png = await rasterize(original);

  writeFileSync(out.coloringSvg, original);
  writeFileSync(out.coloringPng, png);
  // Only once both files are back: the page is the generated one again, so it must stop calling
  // itself hand-fixed and stop offering to undo an edit that no longer exists.
  rmSync(backup, { force: true });

  const status = getStatus(readManifest(orderDir), base);
  if (status !== STATES.MANUAL_IN_PROGRESS && status !== STATES.PENDING_REVIEW) handoff(orderDir, base);
  return acceptReplacement({ orderDir, base, qc });
}

/** Re-generate one photo. A redo always starts from flagged, so it runs the identical code path
 *  a first attempt runs (generatePhoto) and a clean result auto-advances to ok exactly as it
 *  would have in the batch. Regenerating from flagged is also what makes the re-roll differ from
 *  the attempt the operator rejected — generatePhoto raises the step count rather than re-sending
 *  a request this deterministic generator would answer identically.
 *  Regenerates from the operator's original photo when it still exists; the generator's echoed-back
 *  copy is a second JPEG compression and is only the fallback. */
export async function redo({ config, orderDir, base, driver, qc, onEvent }) {
  const manifest = readManifest(orderDir);
  const status = getStatus(manifest, base);
  if (status == null) throw new ReviewError(`No photo "${base}" in ${orderDir}.`);
  if (status !== STATES.FLAGGED) {
    setStatus(manifest, base, STATES.FLAGGED, 'operator requested a redo');
    writeManifest(orderDir, manifest);
  }

  const source = getSource(manifest, base);
  const fallback = outputPaths(`${base}.jpg`, orderDir).original;
  const photoPath = source && existsSync(source) ? source : existsSync(fallback) ? fallback : null;
  if (!photoPath) {
    throw new ReviewError(`Cannot redo "${base}": neither the original photo nor ${fallback} is on disk.`);
  }

  return generatePhoto({ config, photoPath, orderDir, manifest, orderId: manifest.orderId, driver, qc, onEvent });
}
