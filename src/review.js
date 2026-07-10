import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ingestOrders } from './ingest.js';
import { generatePhoto } from './batch.js';
import { outputPaths, photoBase } from './organize.js';
import { assessOutputFiles } from './qcFiles.js';
import { deriveDedication } from './dedication.js';
import {
  STATES,
  getStatus,
  getSource,
  setStatus,
  getDedication,
  setDedication,
  hasDedication,
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
export function reviewState({ inboxRoot, outboxRoot }) {
  let ingested = [];
  try {
    ingested = inboxRoot ? ingestOrders(inboxRoot) : [];
  } catch {
    ingested = []; // no inbox (photos purged, or the operator only kept the outputs)
  }
  const byId = new Map(ingested.map((o) => [o.orderId, o]));

  // Orders that exist only in the outbox still deserve a review page.
  for (const order of outboxOrders(outboxRoot)) if (!byId.has(order.orderId)) byId.set(order.orderId, order);

  const orders = [];
  for (const [orderId, order] of byId) {
    const orderDir = join(outboxRoot, orderId);
    const manifest = readManifest(orderDir);
    const sources = new Map((order.photos ?? []).map((p) => [photoBase(p), p]));
    const bases = sources.size > 0 ? [...sources.keys()] : Object.keys(manifest.photos ?? {});

    const photos = bases.map((base) => {
      const status = getStatus(manifest, base);
      const files = photoFiles(outboxRoot, orderId, base, sources.get(base) ?? getSource(manifest, base));
      return {
        base,
        status,
        reason: manifest.photos?.[base]?.reason ?? null,
        builderEligible: isBuilderEligible(status),
        holdsForReview: holdsForReview(status),
        files,
      };
    });

    orders.push({
      orderId,
      orderDir,
      dirName: order.dirName ?? orderId,
      dedication: getDedication(manifest),
      // Only ever a *suggestion* for an untouched order. Once the operator has decided — even
      // by emptying the box — the grid must show their decision, not talk them out of it.
      suggestedDedication: hasDedication(manifest) ? '' : deriveDedication(bases),
      // What an empty box used to say, so a clear the operator did not mean is one click away.
      clearedDedication: manifest.dedicationWas ?? '',
      photos,
      summary: summarizeOrder(manifest, bases),
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
export function setOrderDedication(orderDir, text) {
  const manifest = readManifest(orderDir);
  const before = getDedication(manifest);
  setDedication(manifest, text);
  const after = getDedication(manifest);

  if (before && !after) manifest.dedicationWas = before;
  else if (after) delete manifest.dedicationWas;

  writeManifest(orderDir, manifest);
  return after;
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
