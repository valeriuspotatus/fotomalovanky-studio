import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, isoWeek, isoWeekKey } from '../src/metrics.js';

// Fixture orders in the ORDER_FIELDS shape. `photos` becomes real "Fotka (N)-M" attributes so the
// tier is derived exactly the way the sidecar derives it, not from a number handed to the test.
const photoAttrs = (n, tier) =>
  Array.from({ length: n }, (_, i) => ({ key: `Fotka (${tier ?? n})-${i + 1}`, value: `https://cdn.tigren.com/p${i + 1}.jpg` }));

const order = ({ at, total = '790.00', status = 'PAID', books = [], currency = 'CZK', extras = [] } = {}) => ({
  name: '#1000',
  createdAt: at,
  displayFinancialStatus: status,
  currentTotalPriceSet: { shopMoney: { amount: total, currencyCode: currency } },
  lineItems: {
    edges: [
      ...books.map((n) => ({ node: { title: 'Fotomalovánky', variantTitle: `… / ${n}`, quantity: 1, customAttributes: photoAttrs(n) } })),
      ...extras.map((title) => ({ node: { title, variantTitle: '', quantity: 1, customAttributes: [] } })),
    ],
  },
});

const NOW = new Date('2026-08-04T09:00:00.000Z'); // a Tuesday, 11:00 in Prague

// ---- what counts ------------------------------------------------------------

test('only money the shop actually has is counted', () => {
  const m = computeMetrics(
    [
      order({ at: '2026-08-02T10:00:00Z', total: '100' }), // PAID
      order({ at: '2026-08-02T10:00:00Z', total: '200', status: 'PARTIALLY_REFUNDED' }), // kept: partly kept
      order({ at: '2026-08-02T10:00:00Z', total: '400', status: 'REFUNDED' }),
      order({ at: '2026-08-02T10:00:00Z', total: '800', status: 'PENDING' }),
      order({ at: '2026-08-02T10:00:00Z', total: '1600', status: 'VOIDED' }),
      order({ at: '2026-08-02T10:00:00Z', total: '3200', status: 'AUTHORIZED' }),
    ],
    { now: NOW },
  );
  assert.equal(m.ordersThisMonth, 2, 'paid and partially refunded');
  assert.equal(m.revenueThisMonth, 300, 'and nothing else — a refunded order is not revenue');
});

test('an order with no usable date joins nothing, rather than landing in an arbitrary bucket', () => {
  const m = computeMetrics([order({ at: null }), order({ at: 'not a date' }), order({ at: '2026-08-02T10:00:00Z', total: '50' })], { now: NOW });
  assert.equal(m.ordersThisMonth, 1);
  assert.equal(m.revenueThisMonth, 50);
});

// ---- calendar months, in Prague ---------------------------------------------

test('months are Prague months — an order just after midnight is not filed under the month before', () => {
  // 2026-07-31T22:30Z is 2026-08-01T00:30 in Prague (CEST, UTC+2). It is an AUGUST order.
  const m = computeMetrics([order({ at: '2026-07-31T22:30:00Z', total: '990' })], { now: NOW });
  assert.equal(m.ordersThisMonth, 1, 'Prague says August');
  assert.equal(m.ordersLastMonth, 0);
  assert.equal(m.revenueThisMonth, 990);

  // The same instant read as UTC would have said July — that is the bug this guards.
  const utc = computeMetrics([order({ at: '2026-07-31T22:30:00Z', total: '990' })], { now: NOW, timeZone: 'UTC' });
  assert.equal(utc.ordersLastMonth, 1, 'and the timezone is what makes the difference');
});

test('this month and last month are separate buckets, and older orders are in neither', () => {
  const m = computeMetrics(
    [
      order({ at: '2026-08-01T08:00:00Z', total: '100' }),
      order({ at: '2026-08-04T08:00:00Z', total: '200' }),
      order({ at: '2026-07-15T08:00:00Z', total: '400' }),
      order({ at: '2026-06-15T08:00:00Z', total: '800' }), // two months back: counted nowhere
    ],
    { now: NOW },
  );
  assert.equal(m.ordersThisMonth, 2);
  assert.equal(m.revenueThisMonth, 300);
  assert.equal(m.ordersLastMonth, 1);
  assert.equal(m.revenueLastMonth, 400);
});

test('January looks back to December of the previous year', () => {
  const m = computeMetrics(
    [order({ at: '2027-01-05T08:00:00Z', total: '100' }), order({ at: '2026-12-20T08:00:00Z', total: '200' })],
    { now: new Date('2027-01-10T09:00:00Z') },
  );
  assert.equal(m.ordersThisMonth, 1);
  assert.equal(m.ordersLastMonth, 1);
  assert.equal(m.revenueLastMonth, 200);
});

// ---- the rolling 30 days ----------------------------------------------------

test('AOV is the rolling 30 days, and the window has an edge', () => {
  const m = computeMetrics(
    [
      order({ at: '2026-08-01T09:00:00Z', total: '1000', books: [8] }),
      order({ at: '2026-07-20T09:00:00Z', total: '500', books: [4] }),
      order({ at: '2026-07-04T08:59:00Z', total: '9999', books: [16] }), // 30 days + 1 min ago: outside
    ],
    { now: NOW },
  );
  assert.equal(m.counted, 2, 'the old order is outside the window');
  assert.equal(m.aov30d, 750, '(1000 + 500) / 2');
});

test('an empty window divides by nothing rather than producing NaN', () => {
  const m = computeMetrics([order({ at: '2026-01-01T09:00:00Z', total: '500' })], { now: NOW });
  assert.equal(m.counted, 0);
  assert.equal(m.aov30d, 0);
  assert.equal(m.pagesPerOrder30d, 0);
  assert.deepEqual(m.tierMix30d, []);
});

// ---- tiers, derived from what the variant title sold ------------------------

test('the tier is what the variant title sold, per line item', () => {
  const m = computeMetrics(
    [
      order({ at: '2026-08-01T09:00:00Z', books: [8] }),
      order({ at: '2026-08-01T09:00:00Z', books: [8] }),
      order({ at: '2026-08-01T09:00:00Z', books: [4] }),
      order({ at: '2026-08-01T09:00:00Z', books: [16] }),
    ],
    { now: NOW },
  );
  assert.deepEqual(m.tierMix30d, [
    { tier: 4, lineItems: 1, share: 0.25 },
    { tier: 8, lineItems: 2, share: 0.5 },
    { tier: 16, lineItems: 1, share: 0.25 },
  ]);
});

test('a customer who bought 8 and uploaded 6 is a tier-8 sale', () => {
  // The mix measures what people BUY. A short upload is a held order, not a smaller purchase, and
  // counting it as tier 6 would show the AOV work losing ground whenever somebody is slow with
  // their photos. Pages, which measure produced book, still read the six that arrived.
  const short = order({ at: '2026-08-01T09:00:00Z' });
  short.lineItems.edges = [{ node: { title: 'Fotomalovánky', variantTitle: '… / 8', quantity: 1, customAttributes: photoAttrs(6, 8) } }];
  const m = computeMetrics([short], { now: NOW });
  assert.deepEqual(m.tierMix30d, [{ tier: 8, lineItems: 1, share: 1 }], 'sold eight');
  assert.equal(m.pagesPerOrder30d, 6, 'produced six');
});

test('a line item with no tier in its variant title is not a sale of any tier', () => {
  // Postage and pencils carry no "… / N". They must not invent a tier, and must not be counted as
  // one either — the mix is a share, so a phantom entry moves every other percentage.
  const m = computeMetrics([order({ at: '2026-08-01T09:00:00Z', books: [8], extras: ['Poštovné', 'Pastelky'] })], { now: NOW });
  assert.deepEqual(m.tierMix30d, [{ tier: 8, lineItems: 1, share: 1 }]);
});

test('a multi-book purchase is two line items in the mix, and postage is none', () => {
  const m = computeMetrics([order({ at: '2026-08-01T09:00:00Z', books: [8, 4], extras: ['Poštovné', 'Pastelky'] })], { now: NOW });
  assert.deepEqual(m.tierMix30d, [
    { tier: 4, lineItems: 1, share: 0.5 },
    { tier: 8, lineItems: 1, share: 0.5 },
  ]);
  assert.equal(m.pagesPerOrder30d, 12, 'both books, one order');
});

test('pages per order averages over ORDERS, not over books', () => {
  const m = computeMetrics(
    [order({ at: '2026-08-01T09:00:00Z', books: [8, 8] }), order({ at: '2026-08-02T09:00:00Z', books: [4] })],
    { now: NOW },
  );
  assert.equal(m.pagesPerOrder30d, 10, '(16 + 4) / 2 orders');
});

// ---- the 12-week trend ------------------------------------------------------

test('ISO weeks are ISO weeks — Thursday decides the year', () => {
  assert.deepEqual(isoWeek({ y: 2026, m: 1, d: 1 }), { year: 2026, week: 1 });
  // 2027-01-01 is a Friday, so that week's Thursday is in 2026: it is week 53 of 2026.
  assert.deepEqual(isoWeek({ y: 2027, m: 1, d: 1 }), { year: 2026, week: 53 });
  assert.equal(isoWeekKey({ y: 2026, m: 8, d: 4 }), '2026-W32');
});

test('the trend is always 12 weeks, oldest first, with quiet weeks present and zero', () => {
  const m = computeMetrics([order({ at: '2026-08-03T09:00:00Z', total: '300' })], { now: NOW });
  assert.equal(m.weeklyTrend.length, 12);
  assert.deepEqual(m.weeklyTrend.map((w) => w.week), [...m.weeklyTrend].map((w) => w.week).sort(), 'oldest first');
  assert.equal(m.weeklyTrend.at(-1).week, '2026-W32', 'the last bucket is the current week');
  assert.deepEqual(m.weeklyTrend.at(-1), { week: '2026-W32', orders: 1, revenue: 300 });
  // A week with nothing in it is reported as zero, never omitted: a gap reads as missing data.
  assert.equal(m.weeklyTrend.filter((w) => w.orders === 0).length, 11);
});

test('an order older than the trend does not appear in it', () => {
  const m = computeMetrics([order({ at: '2026-01-05T09:00:00Z', total: '300' })], { now: NOW });
  assert.equal(m.weeklyTrend.reduce((a, w) => a + w.orders, 0), 0);
});

// ---- shape ------------------------------------------------------------------

test('empty input is a full answer of zeroes, not a missing one', () => {
  const m = computeMetrics([], { now: NOW });
  assert.equal(m.ordersThisMonth, 0);
  assert.equal(m.revenueThisMonth, 0);
  assert.equal(m.aov30d, 0);
  assert.deepEqual(m.tierMix30d, []);
  assert.equal(m.weeklyTrend.length, 12, 'the chart still has its axis');
  assert.equal(m.currency, 'CZK', 'the shop currency, so the page has something to format with');
});

test('junk in the array is skipped, never thrown on', () => {
  for (const junk of [null, undefined, 'order', 42, [], {}]) {
    assert.doesNotThrow(() => computeMetrics([junk, order({ at: '2026-08-01T09:00:00Z' })], { now: NOW }));
  }
  assert.equal(computeMetrics(null, { now: NOW }).ordersThisMonth, 0, 'and so is a missing array');
});

test('money is a number, and no value in the result is a formatted string', () => {
  const m = computeMetrics([order({ at: '2026-08-01T09:00:00Z', total: '1234.50', books: [8] })], { now: NOW });
  assert.equal(m.revenueThisMonth, 1234.5);
  assert.equal(typeof m.aov30d, 'number');
  for (const w of m.weeklyTrend) assert.equal(typeof w.revenue, 'number');
  assert.ok(!JSON.stringify(m).includes('Kč'), 'formatting belongs where the locale is known');
});

test('the currency comes from the shop, not from an assumption', () => {
  const m = computeMetrics([order({ at: '2026-08-01T09:00:00Z', currency: 'EUR' })], { now: NOW });
  assert.equal(m.currency, 'EUR');
});
