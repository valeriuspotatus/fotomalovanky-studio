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
 *  Yes for never-run, auto-flagged (a redo is a fresh roll of the stochastic generator),
 *  and failed (usually a lost GPU job, worth another attempt on the next run).
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

/** The book's title-page text, an order-level operator input. The builder renders a title page
 *  only when this is non-empty, and the operator's current books have one — so an order without
 *  a dedication prints a structurally different (2 pages shorter) book. */
const MAX_DEDICATION = 500;

export function getDedication(manifest) {
  return manifest.dedication ?? '';
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
