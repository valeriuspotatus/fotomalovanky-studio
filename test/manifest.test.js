import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STATES,
  isBuilderEligible,
  holdsForReview,
  needsGeneration,
  summarizeOrder,
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

test('the batch regenerates new, flagged, and failed photos only', () => {
  assert.ok(needsGeneration(null));
  assert.ok(needsGeneration(STATES.FLAGGED));
  assert.ok(needsGeneration(STATES.FAILED));
  assert.ok(!needsGeneration(STATES.OK));
  assert.ok(!needsGeneration(STATES.APPROVED));
  // The operator owns these two — regenerating would overwrite a manual repair.
  assert.ok(!needsGeneration(STATES.MANUAL_IN_PROGRESS));
  assert.ok(!needsGeneration(STATES.PENDING_REVIEW));
});

test('initial assignment is always allowed', () => {
  assert.ok(canTransition(null, STATES.OK));
  assert.ok(canTransition(null, STATES.FLAGGED));
});

test('re-recording the same status is idempotent, not an illegal transition', () => {
  assert.ok(canTransition(STATES.FLAGGED, STATES.FLAGGED));
  assert.ok(canTransition(STATES.FAILED, STATES.FAILED));
  assert.ok(canTransition(STATES.OK, STATES.OK));
});

test('an order is builder-ready only when every photo is eligible', () => {
  const m = emptyManifest('1510');
  setStatus(m, 'a', STATES.OK);
  setStatus(m, 'b', STATES.FLAGGED);
  assert.deepEqual(summarizeOrder(m), { total: 2, eligible: 1, held: 1, manual: 0, failed: 0, pending: 0, ready: false });

  setStatus(m, 'b', STATES.APPROVED);
  assert.equal(summarizeOrder(m).ready, true);
});

test('a photo the manifest never recorded counts as pending, not as absent', () => {
  // A run killed before its last photo was recorded must not read as a complete book.
  const m = emptyManifest('1510');
  setStatus(m, 'a', STATES.OK);
  setStatus(m, 'b', STATES.OK);
  assert.equal(summarizeOrder(m).ready, true, 'the manifest alone looks complete');

  const summary = summarizeOrder(m, ['a', 'b', 'c']);
  assert.equal(summary.pending, 1);
  assert.equal(summary.ready, false, 'but the order has three photos');
});

test('an empty order is not builder-ready', () => {
  assert.equal(summarizeOrder(emptyManifest('1510')).ready, false);
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
