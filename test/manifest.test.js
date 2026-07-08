import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STATES,
  isBuilderEligible,
  holdsForReview,
  isResolved,
  canTransition,
  setStatus,
  getStatus,
  emptyManifest,
  readManifest,
  writeManifest,
  ManifestError,
} from '../src/manifest.js';

test('builder eligibility is limited to ok and approved', () => {
  assert.ok(isBuilderEligible(STATES.OK));
  assert.ok(isBuilderEligible(STATES.APPROVED));
  assert.ok(!isBuilderEligible(STATES.FLAGGED));
  assert.ok(!isBuilderEligible(STATES.PENDING_REVIEW));
});

test('flagged and pending_review hold for review', () => {
  assert.ok(holdsForReview(STATES.FLAGGED));
  assert.ok(holdsForReview(STATES.PENDING_REVIEW));
  assert.ok(!holdsForReview(STATES.OK));
});

test('resume treats ok/approved/failed as resolved, others as unresolved', () => {
  assert.ok(isResolved(STATES.OK));
  assert.ok(isResolved(STATES.APPROVED));
  assert.ok(isResolved(STATES.FAILED));
  assert.ok(!isResolved(STATES.FLAGGED));
  assert.ok(!isResolved(STATES.MANUAL_IN_PROGRESS));
});

test('initial assignment is always allowed', () => {
  assert.ok(canTransition(null, STATES.OK));
  assert.ok(canTransition(null, STATES.FLAGGED));
});

test('setStatus enforces the transition guard', () => {
  const m = emptyManifest('order1');
  setStatus(m, 'abc', STATES.FLAGGED);
  assert.equal(getStatus(m, 'abc'), STATES.FLAGGED);

  // flagged -> manual_in_progress -> pending_review -> approved is the handoff redo path
  setStatus(m, 'abc', STATES.MANUAL_IN_PROGRESS);
  setStatus(m, 'abc', STATES.PENDING_REVIEW);
  setStatus(m, 'abc', STATES.APPROVED);
  assert.equal(getStatus(m, 'abc'), STATES.APPROVED);
});

test('setStatus rejects an illegal transition', () => {
  const m = emptyManifest();
  setStatus(m, 'abc', STATES.OK);
  assert.throws(() => setStatus(m, 'abc', STATES.PENDING_REVIEW), ManifestError);
});

test('setStatus rejects an unknown status', () => {
  const m = emptyManifest();
  assert.throws(() => setStatus(m, 'abc', 'sideways'), ManifestError);
});

test('manifest round-trips through disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-manifest-'));
  try {
    const m = emptyManifest('order1');
    setStatus(m, 'abc', STATES.OK);
    writeManifest(dir, m);
    const back = readManifest(dir);
    assert.equal(getStatus(back, 'abc'), STATES.OK);
    assert.equal(back.orderId, 'order1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readManifest returns an empty manifest when none exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-manifest-'));
  try {
    assert.deepEqual(readManifest(dir), { orderId: null, photos: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
