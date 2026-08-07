import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { getMetrics, readMetricsCache, writeMetricsCache, cacheableMetrics, metricsCachePath, MetricsError } from '../src/metricsCache.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-08-04T09:00:00.000Z');

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-metrics-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const configFor = (dataDir, on = true) => ({
  shopify: { enabled: on, accessToken: on ? 'shpat_xxx' : null, storeDomain: 'x.myshopify.com', apiVersion: '2026-07', dataDir },
});

/** An order node carrying everything this cache must never persist. */
const richOrder = () => ({
  name: '#1560',
  email: 'hofbauerova@example.cz',
  createdAt: '2026-08-01T09:00:00Z',
  updatedAt: '2026-08-01T09:00:00Z',
  displayFinancialStatus: 'PAID',
  currentTotalPriceSet: { shopMoney: { amount: '1290.00', currencyCode: 'CZK' } },
  lineItems: {
    edges: [
      {
        node: {
          title: 'Fotomalovánky',
          variantTitle: '🖨️ Tištěné omalovánky / 8',
          quantity: 1,
          customAttributes: [
            ...Array.from({ length: 8 }, (_, i) => ({ key: `Fotka (8)-${i + 1}`, value: `https://cdn.tigren.com/media/natalka-${i}.jpg` })),
            { key: 'Věnování', value: 'Pro Natálku' },
          ],
        },
      },
    ],
  },
});

// ---- the pull, the cache, and which one answers -----------------------------

test('a fresh cache answers without touching Shopify', async () => {
  const f = fixture();
  try {
    let pulls = 0;
    const listOrders = async () => { pulls++; return [richOrder()]; };
    const config = configFor(f.dir);

    const first = await getMetrics({ config, listOrders, now: () => T0 });
    assert.equal(pulls, 1, 'the first call has nothing to answer from');
    assert.equal(first.cached, false);

    const second = await getMetrics({ config, listOrders, now: () => T0 + 59 * 60 * 1000 });
    assert.equal(pulls, 1, 'still one pull, 59 minutes later');
    assert.equal(second.cached, true);
    assert.equal(second.stale, false);
    assert.deepEqual(second.metrics, first.metrics);
  } finally {
    f.cleanup();
  }
});

test('an hour later it refreshes', async () => {
  const f = fixture();
  try {
    let pulls = 0;
    const listOrders = async () => { pulls++; return [richOrder()]; };
    const config = configFor(f.dir);
    await getMetrics({ config, listOrders, now: () => T0 });
    const later = await getMetrics({ config, listOrders, now: () => T0 + HOUR + 1000 });
    assert.equal(pulls, 2, 'the TTL expired');
    assert.equal(later.cached, false);
  } finally {
    f.cleanup();
  }
});

test('refresh forces a pull past a cache that is still fresh', async () => {
  const f = fixture();
  try {
    let pulls = 0;
    const listOrders = async () => { pulls++; return [richOrder()]; };
    const config = configFor(f.dir);
    await getMetrics({ config, listOrders, now: () => T0 });
    await getMetrics({ config, listOrders, force: true, now: () => T0 + 60_000 });
    assert.equal(pulls, 2);
  } finally {
    f.cleanup();
  }
});

test('the window asked for is 90 days, and the status filter is left to metrics.js', async () => {
  const f = fixture();
  try {
    let seen = null;
    const listOrders = async (args) => { seen = args; return []; };
    await getMetrics({ config: configFor(f.dir), listOrders, now: () => T0 });
    assert.match(seen.query, /^created_at:>=2026-05-06$/, '90 days back, to the day');
    // If Shopify filtered to paid, a PARTIALLY_REFUNDED order would never arrive and the rule in
    // metrics.js that counts it would be dead code. One definition of "counted", and it is tested.
    assert.doesNotMatch(seen.query, /financial_status/, 'the status rule is not duplicated into the query');
  } finally {
    f.cleanup();
  }
});

// ---- when the pull fails ----------------------------------------------------

test('a stale answer beats no answer when Shopify is down', async () => {
  const f = fixture();
  try {
    const good = async () => [richOrder()];
    const config = configFor(f.dir);
    const first = await getMetrics({ config, listOrders: good, now: () => T0 });

    const dead = async () => { throw new Error('502 Bad Gateway'); };
    const out = await getMetrics({ config, listOrders: dead, now: () => T0 + 3 * HOUR });
    assert.equal(out.stale, true, 'and it says so, rather than pretending');
    assert.equal(out.cached, true);
    assert.deepEqual(out.metrics, first.metrics, 'an hour-old AOV is still the right number to within an hour');
    assert.ok(out.ageMs >= 3 * HOUR);
  } finally {
    f.cleanup();
  }
});

test('a failed pull with nothing cached is a 503-shaped error, not an empty dashboard', async () => {
  const f = fixture();
  try {
    const dead = async () => { throw new Error('502 Bad Gateway'); };
    await assert.rejects(
      () => getMetrics({ config: configFor(f.dir), listOrders: dead, now: () => T0 }),
      (err) => err instanceof MetricsError && err.code === 'unavailable' && err.seam === 'metrics',
    );
  } finally {
    f.cleanup();
  }
});

test('Shopify unconfigured is its own code, so the page can say which problem it is', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => getMetrics({ config: configFor(f.dir, false), listOrders: null, now: () => T0 }),
      (err) => err instanceof MetricsError && err.code === 'not-configured',
    );
  } finally {
    f.cleanup();
  }
});

test('an unconfigured shop still serves a cache somebody left behind', async () => {
  const f = fixture();
  try {
    await getMetrics({ config: configFor(f.dir), listOrders: async () => [richOrder()], now: () => T0 });
    const out = await getMetrics({ config: configFor(f.dir, false), listOrders: null, now: () => T0 + 5 * HOUR });
    assert.equal(out.stale, true);
    assert.equal(out.metrics.ordersThisMonth, 1);
  } finally {
    f.cleanup();
  }
});

test('a truncated cache file reads as no cache, and the next pull replaces it', async () => {
  const f = fixture();
  try {
    writeFileSync(metricsCachePath(f.dir), '{"version":1,"at":"2026-08');
    assert.equal(readMetricsCache(f.dir, { now: () => T0 }), null);
    const out = await getMetrics({ config: configFor(f.dir), listOrders: async () => [richOrder()], now: () => T0 });
    assert.equal(out.cached, false);
  } finally {
    f.cleanup();
  }
});

// ---- what reaches the disk --------------------------------------------------

test('the cache file holds aggregates and nothing that identifies anybody', async () => {
  const f = fixture();
  try {
    await getMetrics({ config: configFor(f.dir), listOrders: async () => [richOrder()], now: () => T0 });
    const raw = readFileSync(metricsCachePath(f.dir), 'utf8');

    // The order that produced it carried all of these.
    for (const secret of ['cdn.tigren.com', 'natalka', 'hofbauerova@example.cz', '#1560', 'Věnování', 'Pro Natálku', 'Fotka (8)']) {
      assert.ok(!raw.includes(secret), `the cache must not contain ${JSON.stringify(secret)}`);
    }
    assert.doesNotMatch(raw, /https?:\/\//, 'no URL of any kind');
    assert.doesNotMatch(raw, /@/, 'no address of any kind');

    const parsed = JSON.parse(raw);
    assert.deepEqual(Object.keys(parsed).sort(), ['at', 'metrics', 'version']);
    assert.equal(parsed.metrics.ordersThisMonth, 1);
    assert.deepEqual(parsed.metrics.tierMix30d, [{ tier: 8, lineItems: 1, share: 1 }], 'the tier survives; the photos that implied it do not');
  } finally {
    f.cleanup();
  }
});

test('a field added to the aggregate later does not start persisting itself', () => {
  // The allowlist is the point: computeMetrics takes customer orders as input, so a new key on its
  // output is a new thing that would silently reach a shared disk.
  const clean = cacheableMetrics({
    ordersThisMonth: 3,
    currency: 'CZK',
    tierMix30d: [{ tier: 8, lineItems: 1, share: 1, sampleOrder: '#1560' }],
    weeklyTrend: [{ week: '2026-W32', orders: 1, revenue: 10, customers: ['hofbauerova@example.cz'] }],
    debugOrders: [{ email: 'hofbauerova@example.cz' }],
  });
  const raw = JSON.stringify(clean);
  assert.ok(!('debugOrders' in clean), 'an unknown top-level key is dropped');
  assert.ok(!raw.includes('hofbauerova'), 'and so is one buried in a row');
  assert.ok(!raw.includes('#1560'));
  assert.deepEqual(clean.tierMix30d, [{ tier: 8, lineItems: 1, share: 1 }]);
  assert.deepEqual(clean.weeklyTrend, [{ week: '2026-W32', orders: 1, revenue: 10 }]);
});

test('the cache file is written 0600, because the disk it lives on is shared', { skip: platform() === 'win32' ? 'Windows reports 666 for chmod 0600' : false }, () => {
  const f = fixture();
  try {
    writeMetricsCache(f.dir, { ordersThisMonth: 1 }, { now: () => T0 });
    assert.equal((statSync(metricsCachePath(f.dir)).mode & 0o777).toString(8), '600');
  } finally {
    f.cleanup();
  }
});

test('with no data dir there is nowhere to cache, and that is said plainly', () => {
  assert.equal(readMetricsCache(null), null);
  assert.throws(() => writeMetricsCache(null, {}), (err) => err instanceof MetricsError && err.code === 'not-configured');
});

test('the channel and campaign rows carry counts, never the source string that produced them', () => {
  // `attribution.source` can be a full URL ("https://search.seznam.cz/") and a campaign name is
  // whatever somebody typed into an ad platform. Both reach this file, which lives on a mounted
  // disk a backup or a support session can read — so the rebuild writes a bounded channel name and
  // a length-capped campaign, and copies nothing else off the row.
  const clean = cacheableMetrics({
    channels30d: [
      { channel: 'organic', orders: 8, revenue: 10215, aov: 1276.88, source: 'https://search.seznam.cz/', sampleOrder: '#1563' },
      { channel: 'sneaky', orders: 1, revenue: 1, aov: 1 },
    ],
    campaigns30d: [
      { campaign: 'A+ sales - 3-2026', orders: 17, revenue: 11700, aov: 688.24, referrer: 'https://facebook.com/?u=hofbauerova@example.cz' },
    ],
  });
  const raw = JSON.stringify(clean);

  assert.deepEqual(clean.channels30d, [{ channel: 'organic', orders: 8, revenue: 10215, aov: 1276.88 }], 'the row is rebuilt, and an unknown channel name is dropped entirely');
  assert.deepEqual(clean.campaigns30d, [{ campaign: 'A+ sales - 3-2026', orders: 17, revenue: 11700, aov: 688.24 }]);
  assert.doesNotMatch(raw, /https?:\/\//, 'no URL survives, from either row');
  assert.doesNotMatch(raw, /@/, 'no address survives');
  assert.ok(!raw.includes('#1563'), 'and no order number');
});

test('a campaign named with something enormous is capped rather than written whole', () => {
  const clean = cacheableMetrics({ campaigns30d: [{ campaign: 'x'.repeat(500), orders: 1, revenue: 1, aov: 1 }] });
  assert.equal(clean.campaigns30d[0].campaign.length, 80);
});
