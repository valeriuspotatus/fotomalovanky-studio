import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Per-photo status vocabulary. state.json is the single source of truth for
 *  run/review state and drives resumability + the builder gate. */
export const STATES = Object.freeze({
  OK: 'ok',
  FLAGGED: 'flagged',
  PENDING_REVIEW: 'pending_review',
  MANUAL_IN_PROGRESS: 'manual_in_progress',
  APPROVED: 'approved',
  FAILED: 'failed',
});

const ALL = new Set(Object.values(STATES));

/** Builder-eligible only when clean or explicitly operator-approved. */
export function isBuilderEligible(status) {
  return status === STATES.OK || status === STATES.APPROVED;
}

/** Holds at the review gate until the operator acts. */
export function holdsForReview(status) {
  return status === STATES.FLAGGED || status === STATES.PENDING_REVIEW;
}

/** Should the batch (re-)generate this photo?
 *  Yes for never-run, auto-flagged (which re-rolls with a changed step count — see
 *  `nextAttemptSettings`; an identical re-run would return the identical page), and failed
 *  (usually a lost GPU job, worth another attempt on the next run).
 *  No for finished photos, and no for the two states the *operator* owns —
 *  regenerating those would overwrite a manual repair that is waiting to be reviewed. */
export function needsGeneration(status) {
  return status == null || status === STATES.FLAGGED || status === STATES.FAILED;
}

/** Per-order tally used by the review gate and the run report. An order reaches the builder
 *  only once every one of its photos is builder-eligible.
 *
 *  Pass the order's photo bases: a run killed before its last photo was recorded leaves no
 *  manifest entry for it, and counting only what the manifest knows would call that order
 *  ready and print an incomplete book. An unrecorded photo counts as pending. */
export function summarizeOrder(manifest, bases = Object.keys(manifest.photos ?? {})) {
  const statuses = bases.map((b) => getStatus(manifest, b));
  const count = (fn) => statuses.filter(fn).length;
  return {
    total: bases.length,
    eligible: count(isBuilderEligible),
    held: count(holdsForReview),
    manual: count((s) => s === STATES.MANUAL_IN_PROGRESS),
    failed: count((s) => s === STATES.FAILED),
    pending: count((s) => s == null),
    ready: bases.length > 0 && count(isBuilderEligible) === bases.length,
  };
}

// Legal transitions. from -> allowed to-states.
const TRANSITIONS = {
  [STATES.OK]: [STATES.FLAGGED, STATES.APPROVED, STATES.FAILED],
  [STATES.FLAGGED]: [STATES.APPROVED, STATES.MANUAL_IN_PROGRESS, STATES.OK, STATES.FAILED],
  // FLAGGED: the operator abandoned the handoff and wants the generator to try again instead.
  [STATES.MANUAL_IN_PROGRESS]: [STATES.PENDING_REVIEW, STATES.FLAGGED, STATES.FAILED],
  [STATES.PENDING_REVIEW]: [STATES.APPROVED, STATES.FLAGGED, STATES.MANUAL_IN_PROGRESS, STATES.FAILED],
  [STATES.APPROVED]: [STATES.FLAGGED],
  [STATES.FAILED]: [STATES.OK, STATES.FLAGGED],
};

/** null `from` means initial assignment (always allowed). Re-recording the status a photo
 *  already has is idempotent, not a transition — a redo that comes back just as bad stays
 *  flagged, and a resumed run must be able to re-write what it already wrote. */
export function canTransition(from, to) {
  if (!ALL.has(to)) return false;
  if (from == null || from === to) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export class ManifestError extends Error {}

export function emptyManifest(orderId = null) {
  return { orderId, photos: {} };
}

export function manifestPath(orderDir) {
  return join(orderDir, 'state.json');
}

export function readManifest(orderDir) {
  const p = manifestPath(orderDir);
  if (!existsSync(p)) return emptyManifest();
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function writeManifest(orderDir, manifest) {
  writeFileSync(manifestPath(orderDir), JSON.stringify(manifest, null, 2));
}

export function getStatus(manifest, base) {
  return manifest.photos?.[base]?.status ?? null;
}

/** The book's title-page text, an order-level operator input, usually recovered from the photo
 *  names (see dedication.js). Empty is a legitimate answer: the customer wrote nothing, and their
 *  title page prints without a text line. See `titleTextFor` for what the page count does. */
const MAX_DEDICATION = 500;

export function getDedication(manifest) {
  return manifest.dedication ?? '';
}

/** Has anyone decided this order's title page yet? Distinguishes "never set" — where a text
 *  derived from the photo names is a helpful guess — from "the operator deliberately emptied
 *  it", where re-deriving it would overwrite their decision on every poll. */
export function hasDedication(manifest) {
  return manifest.dedication !== undefined;
}

export function setDedication(manifest, text) {
  manifest.dedication = String(text ?? '').trim().slice(0, MAX_DEDICATION);
  return manifest;
}

/** Set a photo's status, enforcing the transition guard. Merges, so fields that outlive a
 *  status change (`source`) survive it. Returns the manifest. */
export function setStatus(manifest, base, status, reason = null) {
  if (!ALL.has(status)) throw new ManifestError(`Unknown status: ${status}`);
  const current = getStatus(manifest, base);
  if (!canTransition(current, status)) {
    throw new ManifestError(`Illegal transition for ${base}: ${current ?? '(new)'} -> ${status}`);
  }
  manifest.photos ??= {};
  manifest.photos[base] = { ...manifest.photos[base], status, reason };
  return manifest;
}

/** Remember which input photo produced this output, so a redo re-generates from the operator's
 *  original rather than from the generator's own echoed-back copy (a second JPEG compression).
 *  The original may be purged after `retentionDays`; callers fall back to the order folder. */
export function setSource(manifest, base, sourcePath) {
  manifest.photos ??= {};
  manifest.photos[base] = { ...manifest.photos[base], source: sourcePath };
  return manifest;
}

export function getSource(manifest, base) {
  return manifest.photos?.[base]?.source ?? null;
}

/** Remember the generator settings that produced the output now on disk.
 *
 *  A redo has to change at least one of them. At >= 8 diffusion steps this generator is
 *  deterministic within a run: re-sending a byte-identical request returns a byte-identical
 *  page, so a plain re-roll of a bad photo is a no-op that looks like work. The API exposes no
 *  seed, so the step count is the knob we turn. See docs/spikes/2026-07-09-u8-value-gate.md.
 *  Recorded only when generation succeeded — a lost GPU job produced no page to differ from. */
export function setAttempt(manifest, base, attempt) {
  manifest.photos ??= {};
  manifest.photos[base] = { ...manifest.photos[base], attempt: { ...attempt } };
  return manifest;
}

export function getAttempt(manifest, base) {
  return manifest.photos?.[base]?.attempt ?? null;
}

/** Remember that the photo was straightened or cut out of a screenshot before it was drawn (see
 *  photoFraming.js). Recorded so the operator can see it was done and undo it — a correction applied
 *  silently is one nobody can disagree with, and this one is a machine's opinion about a customer's
 *  photograph. Absent for the ordinary photo that needed nothing. */
export function setFraming(manifest, base, framing) {
  manifest.photos ??= {};
  // A photo that needed nothing must also STOP claiming it needed something. Without this, a redo
  // that deliberately dropped the correction ("Přegenerovat z originálu") left the old record
  // standing, and the grid kept offering to undo a crop that was no longer applied.
  if (!framing || (!framing.rotate && !framing.crop)) {
    if (manifest.photos[base]?.framing) {
      const entry = { ...manifest.photos[base] };
      delete entry.framing;
      manifest.photos[base] = entry;
    }
    return manifest;
  }
  // `manual` separates the operator's own rectangle from the vision model's guess: the grid says
  // which one it was, and only the machine's is offered back as "undo it". Present only when true,
  // so the record of an ordinary automatic correction is the two fields it has always been.
  const record = { rotate: framing.rotate ?? 0, cropped: Boolean(framing.crop) };
  if (framing.manual === true) record.manual = true;
  manifest.photos[base] = { ...manifest.photos[base], framing: record };
  return manifest;
}

export function getFraming(manifest, base) {
  return manifest.photos?.[base]?.framing ?? null;
}

// ---- input QC (intake) -----------------------------------------------------
// The order-level intake block: the pre-generation photo checks and the operator's override. Kept
// beside the per-photo statuses so one state.json stays the single source of truth.

export function getIntake(manifest) {
  return manifest.intake ?? null;
}

export function setIntake(manifest, intake) {
  manifest.intake = intake;
  return manifest;
}

/** Drop the stored intake block. Used when a previously-held order passes intake on a re-run —
 *  the hold lifted on its own, so the stale "we're missing photos" verdict must not linger and
 *  keep the order looking held. */
export function clearIntake(manifest) {
  delete manifest.intake;
  return manifest;
}

/** When the operator emailed the customer about a held order (ISO string), or null. Order-level
 *  communication state (N4), orthogonal to the intake verdict: it records that the ball is in the
 *  customer's court since a date, so a held order shows "čeká na zákazníka od X" and doesn't rot
 *  un-chased. Distinct from the drafted email, which is only a copy-paste template. */
export function getEmailedAt(manifest) {
  return manifest.customerEmailedAt ?? null;
}

export function setEmailedAt(manifest, iso) {
  if (iso) manifest.customerEmailedAt = iso;
  else delete manifest.customerEmailedAt;
  return manifest;
}

/** Has the operator said "generate it anyway" despite a held intake verdict? */
export function getIntakeOverride(manifest) {
  return manifest.intake?.override === true;
}

/** Record (or clear) that override, preserving any intake block already written. */
export function setIntakeOverride(manifest, on = true) {
  manifest.intake = { ...(manifest.intake ?? {}), override: Boolean(on) };
  return manifest;
}

/** The persistent "operator knowingly shipped an under-count book" flag, or null. Set only when the
 *  operator overrides a missing-photos hold by typing the reduced page count. It OUTLIVES the hold —
 *  the intake block stays in state.json after the override lifts the hold — so the board, the order
 *  card and the send step all keep warning that this book has fewer pages than the product sold. */
export function getIncompleteBook(manifest) {
  return manifest.intake?.incompleteBook ?? null;
}

export function setIncompleteBook(manifest, { pages, expected }) {
  manifest.intake = {
    ...(manifest.intake ?? {}),
    incompleteBook: { pages, expected, at: new Date().toISOString() },
  };
  return manifest;
}

// ---- the operator's own crop (manual framing) -------------------------------
//
// A RECTANGLE, NOT A FILE. The customer's upload is never rewritten and no second copy of it is
// made: the crop is four fractions of the source frame, stored here, and applied on the way to the
// generator by the same `correction` seam the automatic framing already uses (photoFraming.js ->
// prepareImageForUpload). That is what keeps "the customer original must remain recoverable" true
// by construction rather than by discipline — there is nothing to overwrite and nothing to undo but
// a line of JSON.
//
// The fractions are measured on the source AFTER its EXIF orientation is baked in, because that is
// the frame prepareImageForUpload cuts in and the frame the crop editor is shown. `rotate` is the
// clockwise turn applied AFTER the cut, exactly as photoFraming's is, so the editor hands back a
// box in the un-rotated frame and the two agree.

const ROTATIONS = new Set([0, 90, 180, 270]);
const MIN_CROP_SIDE = 0.02; // 2% of an axis — smaller is a misclick, not an intention

/** Coerce a crop the browser sent into one this pipeline will act on, or throw. Pure, so the whole
 *  decision table is testable: every rejection here is a way a plausible box could ruin a book. */
export function normalizeManualCrop(raw) {
  if (!raw || typeof raw !== 'object') throw new ManifestError('No crop was given.');
  const rotate = Number(raw.rotate ?? 0);
  if (!ROTATIONS.has(rotate)) throw new ManifestError(`Unknown rotation ${raw.rotate} — expected 0, 90, 180 or 270.`);
  const num = (v, what) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ManifestError(`Crop ${what} is not a number.`);
    return n;
  };
  const x = num(raw.x, 'x');
  const y = num(raw.y, 'y');
  const w = num(raw.w, 'width');
  const h = num(raw.h, 'height');
  if (x < 0 || y < 0 || x + w > 1.001 || y + h > 1.001) throw new ManifestError('That crop falls outside the photo.');
  if (w < MIN_CROP_SIDE || h < MIN_CROP_SIDE) throw new ManifestError('That crop is too small to print.');
  // A full-frame box with no turn is not a crop, it is the photo. Storing it would make every
  // later generation skip the automatic framing for no reason.
  if (!rotate && w > 0.999 && h > 0.999) return null;
  const r4 = (v) => Math.round(v * 10000) / 10000;
  return { x: r4(x), y: r4(y), w: r4(Math.min(w, 1 - x)), h: r4(Math.min(h, 1 - y)), rotate };
}

export function getManualCrop(manifest, base) {
  return manifest.photos?.[base]?.manualCrop ?? null;
}

/** Store (or clear, with null) the operator's crop for one photo. */
export function setManualCrop(manifest, base, crop) {
  manifest.photos ??= {};
  const entry = { ...manifest.photos[base] };
  if (crop) entry.manualCrop = { ...crop, at: new Date().toISOString() };
  else delete entry.manualCrop;
  manifest.photos[base] = entry;
  return manifest;
}

/** The `correction` a stored crop becomes on the way to the generator — the same shape
 *  photoFraming.js produces, plus `manual` so nothing downstream treats it as a machine's guess:
 *  the operator's rectangle is exact and must not be second-guessed by the border trimmer. */
export function correctionFromManualCrop(crop) {
  if (!crop) return null;
  return { rotate: crop.rotate ?? 0, screenshot: false, manual: true, crop: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } };
}
