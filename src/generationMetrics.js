// Production-quality telemetry over the durable, privacy-safe generation history in outbox
// manifests. This is deliberately separate from Shopify economics: it needs no customer/order data,
// no cache, and can be rebuilt from state.json after a restart.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WINDOW_DAYS = Object.freeze({ today: 1, '7d': 7, '30d': 30 });

function calendarKey(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function shiftCalendarKey(key, days) {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function emptyWindow() {
  return {
    hasData: false,
    generatedPhotos: null,
    attempts: null,
    acceptedPhotos: null,
    firstPassAcceptanceRate: null,
    exactlyOneRedoRate: null,
    twoPlusRedoRate: null,
    averageAttemptsPerAcceptedPhoto: null,
    generationFailureRate: null,
    humanRejectionRate: null,
    automaticQcFlagRate: null,
    ceilingHitRate: null,
    averageGenerationDurationMs: null,
    medianGenerationDurationMs: null,
    rejectionReasonCounts: {},
  };
}

function aggregate(photos) {
  if (!photos.length) return emptyWindow();
  const attempts = photos.flatMap((photo) => photo.attempts);
  const accepted = photos.map((photo) => {
    const index = photo.attempts.findIndex((item) => item?.humanAccepted === true);
    return index < 0 ? null : { photo, acceptedAttemptNumber: Number(photo.attempts[index]?.attemptNumber) || index + 1 };
  }).filter(Boolean);
  const successful = attempts.filter((item) => item?.result !== 'failure');
  const qcKnown = attempts.filter((item) => typeof item?.automaticQc?.verdict === 'string');
  const durations = attempts.map((item) => Number(item?.durationMs)).filter((value) => Number.isFinite(value) && value >= 0);
  const reasons = {};
  for (const item of attempts) {
    for (const decision of item?.humanDecisions ?? []) {
      if (decision?.decision !== 'rejected') continue;
      const reason = typeof decision.reason === 'string' && decision.reason ? decision.reason : 'unspecified';
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
  }
  return {
    hasData: true,
    generatedPhotos: photos.length,
    attempts: attempts.length,
    acceptedPhotos: accepted.length,
    firstPassAcceptanceRate: ratio(accepted.filter((item) => item.acceptedAttemptNumber === 1).length, accepted.length),
    exactlyOneRedoRate: ratio(accepted.filter((item) => item.acceptedAttemptNumber === 2).length, accepted.length),
    twoPlusRedoRate: ratio(accepted.filter((item) => item.acceptedAttemptNumber >= 3).length, accepted.length),
    averageAttemptsPerAcceptedPhoto: average(accepted.map((item) => item.acceptedAttemptNumber)),
    generationFailureRate: ratio(attempts.filter((item) => item?.result === 'failure').length, attempts.length),
    humanRejectionRate: ratio(successful.filter((item) => item?.humanRejected === true).length, successful.length),
    automaticQcFlagRate: ratio(qcKnown.filter((item) => item.automaticQc.verdict === 'flagged').length, qcKnown.length),
    ceilingHitRate: ratio(photos.filter((photo) => photo.attempts.some((item) => item?.ceilingHit === true)).length, photos.length),
    averageGenerationDurationMs: average(durations),
    medianGenerationDurationMs: median(durations),
    rejectionReasonCounts: Object.fromEntries(Object.entries(reasons).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Photos are cohort-bucketed by their first durable invocation. Keeping every later attempt with
 * that photo makes first-pass/redo percentages a coherent funnel instead of splitting one photo
 * across windows. Legacy photos have no cohort and therefore contribute no invented success. */
export function computeGenerationMetrics(rawPhotos, { now = new Date(), timeZone = 'Europe/Prague' } = {}) {
  const today = calendarKey(now, timeZone);
  const photos = (Array.isArray(rawPhotos) ? rawPhotos : [])
    .map((photo) => ({ attempts: Array.isArray(photo?.attempts) ? photo.attempts.filter((item) => item && typeof item === 'object') : [] }))
    .filter((photo) => photo.attempts.length && calendarKey(photo.attempts[0]?.startedAt, timeZone));
  const out = { all: aggregate(photos) };
  for (const [name, days] of Object.entries(WINDOW_DAYS)) {
    const start = shiftCalendarKey(today, 1 - days);
    out[name] = aggregate(photos.filter((photo) => {
      const cohortDay = calendarKey(photo.attempts[0].startedAt, timeZone);
      return cohortDay >= start && cohortDay <= today;
    }));
  }
  return { today: out.today, '7d': out['7d'], '30d': out['30d'], all: out.all };
}

/** Read only generationAttempts from each order manifest. Malformed folders are skipped just like
 * the live board skips an incomplete outbox entry while a write/deploy is in flight. */
export function readGenerationMetrics(outboxRoot, options = {}) {
  const photos = [];
  if (outboxRoot && existsSync(outboxRoot)) {
    for (const entry of readdirSync(outboxRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(readFileSync(join(outboxRoot, entry.name, 'state.json'), 'utf8'));
        for (const photo of Object.values(manifest?.photos ?? {})) photos.push({ attempts: photo?.generationAttempts });
      } catch { /* absent/partial legacy order: no durable generation history to count */ }
    }
  }
  return computeGenerationMetrics(photos, options);
}
