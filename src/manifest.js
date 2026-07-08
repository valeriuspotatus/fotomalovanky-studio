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

/** Resume skips only "resolved" photos; flagged / pending / manual are picked up again. */
export function isResolved(status) {
  return isBuilderEligible(status) || status === STATES.FAILED;
}

// Legal transitions. from -> allowed to-states.
const TRANSITIONS = {
  [STATES.OK]: [STATES.FLAGGED, STATES.APPROVED, STATES.FAILED],
  [STATES.FLAGGED]: [STATES.APPROVED, STATES.MANUAL_IN_PROGRESS, STATES.OK, STATES.FAILED],
  [STATES.MANUAL_IN_PROGRESS]: [STATES.PENDING_REVIEW, STATES.FAILED],
  [STATES.PENDING_REVIEW]: [STATES.APPROVED, STATES.FLAGGED, STATES.MANUAL_IN_PROGRESS, STATES.FAILED],
  [STATES.APPROVED]: [STATES.FLAGGED],
  [STATES.FAILED]: [STATES.OK, STATES.FLAGGED],
};

/** null `from` means initial assignment (always allowed). */
export function canTransition(from, to) {
  if (!ALL.has(to)) return false;
  if (from == null) return true;
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

/** Set a photo's status, enforcing the transition guard. Returns the manifest. */
export function setStatus(manifest, base, status, reason = null) {
  if (!ALL.has(status)) throw new ManifestError(`Unknown status: ${status}`);
  const current = getStatus(manifest, base);
  if (!canTransition(current, status)) {
    throw new ManifestError(`Illegal transition for ${base}: ${current ?? '(new)'} -> ${status}`);
  }
  manifest.photos ??= {};
  manifest.photos[base] = { status, reason };
  return manifest;
}
