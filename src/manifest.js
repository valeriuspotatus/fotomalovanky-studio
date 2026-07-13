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
