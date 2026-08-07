// What the shop spent on advertising, so the homepage can say whether it came back.
//
// WHY THIS IS NOT PART OF THE METRICS CACHE. That cache is derived and disposable: it holds an
// answer recomputed from Shopify every hour, and throwing it away costs nothing but a refresh. A
// spend figure is the opposite — the operator typed it, nothing else in the system knows it, and a
// cache refresh must never be able to lose it. Different lifetime, different file.
//
// TYPED BEATS FETCHED, ALWAYS. Once the Meta integration exists it will write records here with
// `source: 'meta'`. A figure the operator entered by hand for the same period still wins, because
// the reason they typed one is that the fetched number was absent, stale or wrong.
//
// MISSING IS NOT ZERO. A window with no record returns null, and the page says it does not know.
// Zero would compute a return on spend of infinity and read as "the ads are free", which is the
// most flattering possible lie about the one number this page exists to answer.
//
// 0o600 for the reason metricsCache.js gives: on Render this lands on a mounted disk that a backup,
// a support session or a stray `ls` can reach.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AD_SPEND_FILE = 'adSpend.json';
export const adSpendPath = (dataDir) => join(dataDir, AD_SPEND_FILE);

/** Where a figure came from. `typed` is the operator; `meta` is the API, once that lands. */
export const SPEND_SOURCES = Object.freeze({ TYPED: 'typed', META: 'meta' });

const MAX_RECORDS = 400; // ~8 years of weekly figures; a cap so a loop cannot grow the file forever

/** A spend-seam failure, phrased for the operator. Carries `seam` like the other drivers. */
export class AdSpendError extends Error {
  constructor(message, code = 'ad-spend') {
    super(message);
    this.name = 'AdSpendError';
    this.seam = 'ad-spend';
    this.code = code;
  }
}

const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** One stored record, rebuilt field by field. Anything else on the object is dropped — the same
 *  reasoning as the metrics allowlist, applied to a file that is written from an HTTP body. */
function cleanRecord(r) {
  const amount = Number(r?.amount);
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (!isIso(r?.from) || !isIso(r?.to)) return null;
  if (Date.parse(r.from) > Date.parse(r.to)) return null;
  const source = r?.source === SPEND_SOURCES.META ? SPEND_SOURCES.META : SPEND_SOURCES.TYPED;
  return {
    from: new Date(r.from).toISOString(),
    to: new Date(r.to).toISOString(),
    amount: Math.round(amount * 100) / 100,
    currency: typeof r?.currency === 'string' && r.currency ? r.currency.slice(0, 8) : 'CZK',
    source,
    at: isIso(r?.at) ? new Date(r.at).toISOString() : new Date().toISOString(),
  };
}

/** Every stored record, newest first. Unreadable reads as empty: a hand-edited or truncated file is
 *  not worth an error the operator cannot act on, and the next write replaces it. */
export function readAdSpend(dataDir) {
  if (!dataDir) return [];
  const path = adSpendPath(dataDir);
  if (!existsSync(path)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  const records = Array.isArray(parsed?.records) ? parsed.records : [];
  return records
    .map(cleanRecord)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.from) - Date.parse(a.from));
}

/** Store one figure. A typed record replaces an existing record for the same period and source, so
 *  correcting a typo does not leave two contradictory figures in the file. */
export function writeAdSpend(dataDir, record, { now = Date.now } = {}) {
  if (!dataDir) throw new AdSpendError('an ad-spend data directory is required (shopify.dataDir).', 'not-configured');
  const clean = cleanRecord({ ...record, at: new Date(now()).toISOString() });
  if (!clean) throw new AdSpendError('a spend figure needs a non-negative amount and a from/to period.', 'invalid');

  const kept = readAdSpend(dataDir).filter((r) => !(r.from === clean.from && r.to === clean.to && r.source === clean.source));
  const records = [clean, ...kept].slice(0, MAX_RECORDS);

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(adSpendPath(dataDir), JSON.stringify({ version: 1, records }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return clean;
}

/** The figure that applies to a window, or null when nothing does.
 *
 *  A record counts when its period overlaps the window at all, and overlapping records are summed —
 *  four weekly figures across a 30-day window are that window's spend. Typed records win outright:
 *  if any typed record overlaps, fetched ones are ignored entirely rather than added to them, which
 *  is what stops a hand-entered correction from being double-counted against the number it was
 *  entered to replace. */
export function spendForWindow(dataDir, { from, to } = {}) {
  if (!isIso(from) || !isIso(to)) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);

  const overlapping = readAdSpend(dataDir).filter((r) => Date.parse(r.from) <= end && Date.parse(r.to) >= start);
  if (!overlapping.length) return null;

  const typed = overlapping.filter((r) => r.source === SPEND_SOURCES.TYPED);
  const used = typed.length ? typed : overlapping;

  return {
    amount: Math.round(used.reduce((sum, r) => sum + r.amount, 0) * 100) / 100,
    currency: used[0].currency,
    source: typed.length ? SPEND_SOURCES.TYPED : used[0].source,
    records: used.length,
    at: used[0].at,
  };
}
