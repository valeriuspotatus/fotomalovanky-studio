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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AD_SPEND_FILE = 'adSpend.json';
export const adSpendPath = (dataDir) => join(dataDir, AD_SPEND_FILE);

/** Where a figure came from. `typed` is the operator; `meta` is the API, once that lands. */
export const SPEND_SOURCES = Object.freeze({ TYPED: 'typed', META: 'meta' });

const MAX_RECORDS = 400; // ~8 years of weekly figures; a cap so a loop cannot grow the file forever
const MAX_AMOUNT = 1e12; // a thousand billion crowns of ad spend is a typo, not a budget

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
  // Number.isFinite rejects Infinity as well as NaN, and that is load-bearing rather than tidy:
  // JSON.stringify writes Infinity as `null`, which reads back as 0, which renders as a genuine
  // zero spend and therefore an infinite return — the exact lie this module exists to prevent.
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) return null;
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

/** Do two periods cover any of the same time? */
const overlaps = (a, b) => Date.parse(a.from) <= Date.parse(b.to) && Date.parse(a.to) >= Date.parse(b.from);

/** Store one figure. A new record REPLACES any same-source record whose period it overlaps.
 *
 *  Overlap, not an exact period match, and this is the whole correctness of the store. The page
 *  writes a rolling 30 days ending *now*, so a figure entered today and the same figure entered
 *  tomorrow have different bounds by a day — an exact match never fires, both records survive, both
 *  overlap the displayed window, and `spendForWindow` sums them. Typing 6 200 three times stored
 *  18 600 and turned a true 2.38x return into 0.79x. The page's most likely use — enter a figure,
 *  come back, enter the updated one — silently produced the wrong headline number.
 *
 *  Adjacent weekly figures do not overlap each other, so they still sum. A wider figure entered
 *  later supersedes the slices it covers, which is what "I'll just type the month" should mean. */
export function writeAdSpend(dataDir, record, { now = Date.now } = {}) {
  if (!dataDir) throw new AdSpendError('an ad-spend data directory is required (shopify.dataDir).', 'not-configured');
  const clean = cleanRecord({ ...record, at: new Date(now()).toISOString() });
  if (!clean) throw new AdSpendError('a spend figure needs a non-negative amount and a from/to period.', 'invalid');

  const kept = readAdSpend(dataDir).filter((r) => !(r.source === clean.source && overlaps(r, clean)));
  const records = [clean, ...kept].slice(0, MAX_RECORDS);

  mkdirSync(dataDir, { recursive: true });
  writeAtomic(adSpendPath(dataDir), JSON.stringify({ version: 1, records }, null, 2) + '\n');
  return clean;
}

/** Write through a temp file and rename over the target.
 *
 *  A plain in-place write can be interrupted — a crash, a full disk, a killed process — and leave a
 *  truncated file. `readAdSpend` treats an unparseable file as no data, so a torn write does not
 *  error: it silently reads back as "nobody has entered any spend", losing the one figure in this
 *  system that exists nowhere else. Rename is atomic on the same volume, so a reader sees either the
 *  old file or the new one. */
function writeAtomic(path, contents) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* the rename already failed; nothing else to do */ }
    throw err;
  }
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
