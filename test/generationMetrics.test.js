import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { computeGenerationMetrics, readGenerationMetrics } from '../src/generationMetrics.js';

const NOW = new Date('2026-08-21T10:00:00.000Z'); // 12:00 Europe/Prague

const attempt = (n, overrides = {}) => ({
  attemptId: `a${n}`,
  attemptNumber: n,
  startedAt: `2026-08-${String(20 + n).padStart(2, '0')}T08:00:00.000Z`,
  finishedAt: `2026-08-${String(20 + n).padStart(2, '0')}T08:00:01.000Z`,
  durationMs: 1000,
  kind: n === 1 ? 'initial' : 'redo',
  result: 'success',
  ...overrides,
});

test('generation funnel and quality rates come from durable attempts', () => {
  const photos = [
    { attempts: [attempt(1, { humanAccepted: true, automaticQc: { verdict: 'ok' } })] },
    { attempts: [attempt(1, { humanRejected: true, humanDecisions: [{ decision: 'rejected', reason: 'anatomy' }], automaticQc: { verdict: 'flagged' } }), attempt(2, { humanAccepted: true, durationMs: 3000 })] },
    { attempts: [attempt(1, { result: 'failure', failureReason: 'timeout' }), attempt(2, { humanRejected: true, humanDecisions: [{ decision: 'rejected', reason: 'crop' }] }), attempt(3, { humanAccepted: true, ceilingHit: true, durationMs: 5000 })] },
  ];
  const all = computeGenerationMetrics(photos, { now: NOW }).all;
  assert.deepEqual({ generatedPhotos: all.generatedPhotos, attempts: all.attempts, acceptedPhotos: all.acceptedPhotos }, { generatedPhotos: 3, attempts: 6, acceptedPhotos: 3 });
  assert.equal(all.firstPassAcceptanceRate, 1 / 3);
  assert.equal(all.exactlyOneRedoRate, 1 / 3);
  assert.equal(all.twoPlusRedoRate, 1 / 3);
  assert.equal(all.averageAttemptsPerAcceptedPhoto, 2);
  assert.equal(all.generationFailureRate, 1 / 6);
  assert.equal(all.humanRejectionRate, 2 / 5, 'human rejection is per successful generated output');
  assert.equal(all.automaticQcFlagRate, 1 / 2, 'unknown QC is not silently treated as a pass');
  assert.equal(all.ceilingHitRate, 1 / 3);
  assert.equal(all.averageGenerationDurationMs, 2000);
  assert.equal(all.medianGenerationDurationMs, 1000);
  assert.deepEqual(all.rejectionReasonCounts, { anatomy: 1, crop: 1 });
});

test('legacy manifests are no-data, never fabricated first-pass successes', () => {
  const out = computeGenerationMetrics([{ attempts: null }, { attempts: [] }], { now: NOW });
  for (const window of Object.values(out)) {
    assert.equal(window.hasData, false);
    assert.equal(window.generatedPhotos, null);
    assert.equal(window.firstPassAcceptanceRate, null);
  }
});

test('known empty numerators are numeric zero while absent denominators remain null', () => {
  const all = computeGenerationMetrics([{ attempts: [attempt(1)] }], { now: NOW }).all;
  assert.equal(all.generatedPhotos, 1);
  assert.equal(all.acceptedPhotos, 0);
  assert.equal(all.firstPassAcceptanceRate, null, 'there is no accepted-photo denominator');
  assert.equal(all.generationFailureRate, 0);
  assert.equal(all.humanRejectionRate, 0);
  assert.equal(all.automaticQcFlagRate, null, 'no QC verdicts were recorded');
  assert.deepEqual(all.rejectionReasonCounts, {});
});

test('today and rolling calendar windows use Europe/Prague boundaries', () => {
  const photos = [
    { attempts: [attempt(1, { startedAt: '2026-08-20T21:59:59.999Z' })] }, // 23:59 Prague: yesterday
    { attempts: [attempt(1, { startedAt: '2026-08-20T22:00:00.000Z' })] }, // midnight Prague: today
    { attempts: [attempt(1, { startedAt: '2026-08-14T21:59:59.999Z' })] }, // before 7-calendar-day start
    { attempts: [attempt(1, { startedAt: '2026-08-14T22:00:00.000Z' })] },
    { attempts: [attempt(1, { startedAt: '2026-08-21T22:00:00.000Z' })] }, // tomorrow in Prague
  ];
  const out = computeGenerationMetrics(photos, { now: NOW, timeZone: 'Europe/Prague' });
  assert.equal(out.today.generatedPhotos, 1);
  assert.equal(out['7d'].generatedPhotos, 3);
  assert.equal(out['30d'].generatedPhotos, 4);
  assert.equal(out.all.generatedPhotos, 5, 'all-time retains valid future-dated telemetry for clock-skew diagnosis');
});

test('outbox reader aggregates valid manifests and ignores unrelated or malformed entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-generation-metrics-'));
  try {
    const order = join(root, '1900');
    mkdirSync(order);
    writeFileSync(join(order, 'state.json'), JSON.stringify({ photos: { one: { generationAttempts: [attempt(1)] }, legacy: { attempt: { steps: 20 } } } }));
    mkdirSync(join(root, 'broken'));
    writeFileSync(join(root, 'broken', 'state.json'), '{bad json');
    const out = readGenerationMetrics(root, { now: NOW });
    assert.equal(out.all.generatedPhotos, 1);
    assert.equal(out.all.attempts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
