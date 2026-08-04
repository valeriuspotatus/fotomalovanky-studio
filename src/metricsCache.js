// The disk half of /api/metrics: pull, aggregate, keep the ANSWER for an hour.
//
// WHAT IS CACHED IS THE AGGREGATE, NEVER THE ORDERS.
//
// The pull that feeds this carries 90 days of customer orders — names, e-mail addresses and the
// photo URLs of their children. None of that is needed once computeMetrics has run, so none of it is
// written: the cache holds counts, sums and averages and nothing that identifies anybody. The write
// runs the aggregate through an ALLOWLIST rather than deleting known-bad keys, so a field added to
// computeMetrics later cannot quietly start persisting whatever it happens to contain. A test
// serialises the file and asserts no photo URL and no customer field survives.
//
// 0o600 for the same reason accounts.js uses it: on Render this lands on a mounted disk that a
// backup, a support session or a stray `ls` can reach.
//
// The TTL exists to protect the SHOP, not this process. Every miss is 90 days of orders over the
// Admin API, and the homepage is polled by a browser tab somebody leaves open all day.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeMetrics } from './metrics.js';

export const METRICS_FILE = 'metrics.json';
export const metricsCachePath = (dataDir) => join(dataDir, METRICS_FILE);

const TTL_MS = 60 * 60 * 1000; // one hour
const WINDOW_DAYS = 90;

/** A metrics-seam failure, phrased for the operator. Carries `seam` like the other drivers. */
export class MetricsError extends Error {
  constructor(message, code = 'metrics') {
    super(message);
    this.name = 'MetricsError';
    this.seam = 'metrics';
    this.code = code;
  }
}

/** Exactly the fields allowed onto the disk. Anything computeMetrics grows later is absent until
 *  somebody adds it here on purpose — which is the point, because the input to that function is
 *  customer orders. */
const CACHEABLE = Object.freeze([
  'ordersThisMonth',
  'ordersLastMonth',
  'revenueThisMonth',
  'revenueLastMonth',
  'aov30d',
  'tierMix30d',
  'pagesPerOrder30d',
  'weeklyTrend',
  'currency',
  'counted',
]);

/** The aggregate, reduced to the allowlist and to plain numbers/strings. Nested rows are rebuilt
 *  field by field rather than spread, so an extra key on a tier or a week cannot ride along. */
export function cacheableMetrics(metrics) {
  const out = {};
  for (const key of CACHEABLE) {
    const v = metrics?.[key];
    if (key === 'tierMix30d') {
      out[key] = (Array.isArray(v) ? v : []).map((t) => ({ tier: Number(t?.tier) || 0, lineItems: Number(t?.lineItems) || 0, share: Number(t?.share) || 0 }));
    } else if (key === 'weeklyTrend') {
      out[key] = (Array.isArray(v) ? v : []).map((w) => ({ week: String(w?.week ?? ''), orders: Number(w?.orders) || 0, revenue: Number(w?.revenue) || 0 }));
    } else if (key === 'currency') {
      out[key] = typeof v === 'string' && v ? v : 'CZK';
    } else {
      out[key] = Number(v) || 0;
    }
  }
  return out;
}

/** Read the cached aggregate, or null when there is none, it is unreadable, or it has expired.
 *  Unreadable is treated as absent: a truncated write is not worth an error the operator cannot act
 *  on, and the next refresh replaces it. */
export function readMetricsCache(dataDir, { now = Date.now, ttlMs = TTL_MS } = {}) {
  if (!dataDir) return null;
  const path = metricsCachePath(dataDir);
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const at = Date.parse(parsed?.at ?? '');
  if (!parsed?.metrics || Number.isNaN(at)) return null;
  const age = now() - at;
  return { metrics: parsed.metrics, at: parsed.at, ageMs: age, fresh: age >= 0 && age < ttlMs };
}

/** Persist the aggregate. Returns what was written. */
export function writeMetricsCache(dataDir, metrics, { now = Date.now } = {}) {
  if (!dataDir) throw new MetricsError('a metrics data directory is required (shopify.dataDir).', 'not-configured');
  mkdirSync(dataDir, { recursive: true });
  const body = { version: 1, at: new Date(now()).toISOString(), metrics: cacheableMetrics(metrics) };
  writeFileSync(metricsCachePath(dataDir), JSON.stringify(body, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return body;
}

/**
 * The endpoint's whole job: a fresh cache, or a pull that refreshes it, or the stale cache when the
 * pull fails.
 *
 * A STALE ANSWER BEATS NO ANSWER. If Shopify is down, an hour-old AOV is still the right number to
 * within an hour, and a blank dashboard tells the operator nothing except that something is broken.
 * The response says which it is (`stale`, `ageMs`) so the page can label it rather than pretend.
 *
 * @param {object}   o
 * @param {object}   o.config      the resolved config
 * @param {function} o.listOrders  injected — `({query}) => Promise<node[]>`
 * @param {boolean}  [o.force]     ignore a fresh cache and pull anyway
 * @param {function} [o.now]       injected clock
 * @returns {Promise<{metrics:object, at:string, cached:boolean, stale:boolean, ageMs:number}>}
 * @throws {MetricsError} only when there is no answer at all to give
 */
export async function getMetrics({ config, listOrders, force = false, now = Date.now, ttlMs = TTL_MS } = {}) {
  const dataDir = config?.shopify?.dataDir ?? null;
  const cached = readMetricsCache(dataDir, { now, ttlMs });
  if (cached?.fresh && !force) {
    return { metrics: cached.metrics, at: cached.at, cached: true, stale: false, ageMs: cached.ageMs };
  }

  if (!config?.shopify?.enabled || !config?.shopify?.accessToken || typeof listOrders !== 'function') {
    if (cached) return { metrics: cached.metrics, at: cached.at, cached: true, stale: true, ageMs: cached.ageMs };
    throw new MetricsError('Shopify není nastavené — ekonomika objednávek nemá odkud číst.', 'not-configured');
  }

  try {
    // Deliberately NOT "financial_status:paid". metrics.js already decides what counts, and it counts
    // PARTIALLY_REFUNDED as well as PAID; filtering at Shopify would drop those before they arrived
    // and leave that rule as dead code. One definition of "counted", and it is the tested one.
    const since = new Date(now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    const nodes = await listOrders({ query: `created_at:>=${since}` });
    const metrics = computeMetrics(nodes, { now: new Date(now()) });
    const written = writeMetricsCache(dataDir, metrics, { now });
    return { metrics: written.metrics, at: written.at, cached: false, stale: false, ageMs: 0 };
  } catch (err) {
    if (cached) return { metrics: cached.metrics, at: cached.at, cached: true, stale: true, ageMs: cached.ageMs };
    throw new MetricsError(`Objednávky se nepodařilo načíst: ${err.message}`, 'unavailable');
  }
}
