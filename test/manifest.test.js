import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STATES,
  setFraming,
  getFraming,
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
  getEmailedAt,
  setEmailedAt,
  ManifestError,
  appendGenerationAttempt,
  getGenerationAttempts,
  getCurrentGenerationAttempt,
  recordHumanDecision,
} from '../src/manifest.js';

test('generation history is absent on legacy manifests and appends without changing prior attempts', () => {
  const m = { orderId: 'legacy', photos: { a: { status: STATES.OK, attempt: { steps: 8, variant: 'old' } } } };
  assert.deepEqual(getGenerationAttempts(m, 'a'), []);
  assert.equal(getCurrentGenerationAttempt(m, 'a'), null);

  const first = appendGenerationAttempt(m, 'a', {
    startedAt: '2026-08-21T10:00:00.000Z', finishedAt: '2026-08-21T10:00:02.000Z',
    durationMs: 2000, kind: 'initial', variant: 'v1', diffusionSteps: 8,
    result: 'success', automaticQc: { verdict: 'flagged', reason: 'near-blank', metrics: { inkCoverage: 0.01 } },
  });
  const snapshot = structuredClone(first);
  const second = appendGenerationAttempt(m, 'a', {
    startedAt: '2026-08-21T10:01:00.000Z', finishedAt: '2026-08-21T10:01:03.000Z',
    durationMs: 3000, kind: 'redo', variant: 'v1', diffusionSteps: 9, result: 'failure', failureReason: 'worker lost',
  });
  assert.equal(first.attemptNumber, 1);
  assert.equal(second.attemptNumber, 2);
  assert.notEqual(first.attemptId, second.attemptId);
  assert.deepEqual(getGenerationAttempts(m, 'a')[0], snapshot, 'later appends never rewrite completed history');
  assert.equal(getCurrentGenerationAttempt(m, 'a').attemptId, second.attemptId);
});

test('attempt telemetry allowlists settings and human decisions target the current attempt', () => {
  const m = emptyManifest('1510');
  appendGenerationAttempt(m, 'a', {
    kind: 'initial', variant: 'safe', diffusionSteps: 8, result: 'success',
    settings: { diffusionSteps: 8, variant: 'safe', mode: 'api', token: 'SECRET', apiKey: 'SECRET', baseUrl: 'https://secret.test/token' },
  });
  recordHumanDecision(m, 'a', { decision: 'rejected', reason: 'anatomy', source: 'human', action: 'redo', at: '2026-08-21T10:00:00.000Z' });
  const attempt = getCurrentGenerationAttempt(m, 'a');
  assert.deepEqual(attempt.settings, { diffusionSteps: 8, variant: 'safe', mode: 'api' });
  assert.equal(attempt.humanRejected, true);
  assert.equal(attempt.humanDecisions[0].reason, 'anatomy');
  assert.doesNotMatch(JSON.stringify(m), /SECRET|secret\.test/);
});

test('attempt and decision history survives a manifest write and reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-history-'));
  try {
    const m = emptyManifest('1510');
    appendGenerationAttempt(m, 'a', {
      kind: 'initial', result: 'success', diffusionSteps: 8,
      automaticQc: { verdict: 'ok', reason: 'ok', metrics: { coverage: 0.1 } },
    });
    recordHumanDecision(m, 'a', { decision: 'accepted', source: 'human', action: 'approve', manualRepair: true });
    writeManifest(dir, m);
    const current = getCurrentGenerationAttempt(readManifest(dir), 'a');
    assert.equal(current.humanAccepted, true);
    assert.equal(current.humanDecisions[0].manualRepair, true);
    assert.equal(current.attemptsBeforeDecision, 1);
    assert.equal(current.acceptedAfterAutomaticQcOk, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('customer-emailed timestamp round-trips and clears (N4)', () => {
  const m = emptyManifest('1510');
  assert.equal(getEmailedAt(m), null, 'unset by default');
  setEmailedAt(m, '2026-07-10T08:00:00.000Z');
  assert.equal(getEmailedAt(m), '2026-07-10T08:00:00.000Z');
  setEmailedAt(m, null);
  assert.equal(getEmailedAt(m), null, 'cleared');
  assert.equal('customerEmailedAt' in m, false, 'the field is removed, not left as null');
});

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

// ---- automatic framing (photoFraming.js) ------------------------------------

test('a straightened or cropped photo records what was done to it', () => {
  const m = setFraming({}, '1560_img0003', { rotate: 90, screenshot: false, crop: null });
  assert.deepEqual(getFraming(m, '1560_img0003'), { rotate: 90, cropped: false });

  const shot = setFraming({}, 'a', { rotate: 0, screenshot: true, crop: { x: 0, y: 0.1, w: 1, h: 0.6 } });
  assert.deepEqual(getFraming(shot, 'a'), { rotate: 0, cropped: true });
});

test('a photo that needed nothing carries no framing record at all', () => {
  // The ordinary case, and nearly every photo. An empty record would put a chip on every tile.
  assert.equal(getFraming(setFraming({}, 'a', { rotate: 0, crop: null }), 'a'), null);
  assert.equal(getFraming(setFraming({}, 'a', null), 'a'), null);
  assert.equal(getFraming({}, 'never-seen'), null);
});

test('recording the framing leaves the rest of the photo entry alone', () => {
  let m = setStatus({}, 'a', STATES.OK, 'ok');
  m = setFraming(m, 'a', { rotate: 180, crop: null });
  assert.equal(getStatus(m, 'a'), STATES.OK, 'the verdict survives');
  assert.deepEqual(getFraming(m, 'a'), { rotate: 180, cropped: false });
});
