// Unit economics for the studio homepage: is the AOV / tier-mix fix working.
//
// Pure aggregation over raw Shopify order nodes, in the shape src/shopify/orders.js works in — no
// I/O, no clock of its own, no formatting. `now` is injected so the month boundaries and the rolling
// windows are testable, and every money value comes out a NUMBER in the shop's own currency. How a
// number is written ("1 234 Kč") is the page's decision and belongs where the locale is known.
//
// WHAT IS COUNTED. An order joins the totals when `displayFinancialStatus` is PAID or
// PARTIALLY_REFUNDED. Everything else — pending, voided, fully refunded, an authorised card that
// never captured — is money the shop does not have, and an AOV that counts it is an AOV that flatters
// the very thing this page exists to measure.
//
// CALENDAR MONTHS ARE PRAGUE MONTHS. "This month" has to mean what it means to the operator looking
// at the screen, so every order's date is resolved in Europe/Prague before anything is bucketed.
// An order placed at 00:30 CEST on the 1st is UTC 22:30 on the previous month's last day, and
// bucketing on UTC would file it under the wrong month — visibly wrong on exactly the two days a
// month anybody checks. Intl does the conversion; there is no timezone dependency to add.

import { expectedPhotosFrom, lineItemPhotoCount } from './shopify/orders.js';

/** The statuses that mean the shop was actually paid. */
const COUNTED = new Set(['PAID', 'PARTIALLY_REFUNDED']);

const DAY_MS = 86_400_000;
const ROLLING_DAYS = 30;
const TREND_WEEKS = 12;

/** An order's calendar date in a given zone, as plain numbers. `en-CA` formats as YYYY-MM-DD, which
 *  is the one locale that needs no parsing beyond a split. */
function zonedDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const [y, m, d] = parts.split('-').map(Number);
  return { y, m, d };
}

/** The ISO-8601 week a calendar date falls in. Thursday decides the year, which is why the last days
 *  of December can belong to week 1 of the next year and the first days of January to week 52 of the
 *  last — the reason this is not `Math.floor(dayOfYear / 7)`.
 *
 *  Arithmetic in UTC on purpose: the calendar date is already resolved to the target zone, so this
 *  only has to count days, and a UTC date cannot lose an hour to a DST change while doing it. */
export function isoWeek({ y, m, d }) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = dt.getUTCDay() || 7; // Sunday is 7, not 0
  dt.setUTCDate(dt.getUTCDate() + 4 - dayOfWeek); // move to the Thursday of this week
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt - yearStart) / DAY_MS + 1) / 7);
  return { year: dt.getUTCFullYear(), week };
}

/** "2026-W31" — sortable, and the label the trend renders. */
export function isoWeekKey(parts) {
  const { year, week } = isoWeek(parts);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The money on an order, as a number. Shopify sends amounts as decimal STRINGS ("790.00") because
 *  a float cannot hold every decimal exactly; they are parsed once, here, and never re-serialised. */
function amountOf(node) {
  const raw = node?.currentTotalPriceSet?.shopMoney?.amount;
  const n = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function currencyOf(node) {
  const c = node?.currentTotalPriceSet?.shopMoney?.currencyCode;
  return typeof c === 'string' && c ? c : null;
}

/** Round a mean to 2 decimals. A value decision, not formatting: an average of 7.333333333 pages
 *  carries no information past the second place and makes every assertion about it awkward. */
const mean2 = (total, count) => (count > 0 ? Math.round((total / count) * 100) / 100 : 0);

/** Shift a calendar date by whole days, staying in the calendar rather than the clock. */
function addDays({ y, m, d }, days) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/**
 * Aggregate raw order nodes into the homepage's numbers.
 *
 * @param {object[]} nodes    raw Shopify order nodes (ORDER_FIELDS shape)
 * @param {object}   [opts]
 * @param {Date}     [opts.now]       the moment "this month" and "last 30 days" are measured from
 * @param {string}   [opts.timeZone]  the calendar the operator reads
 * @returns {{
 *   ordersThisMonth:number, ordersLastMonth:number,
 *   revenueThisMonth:number, revenueLastMonth:number,
 *   aov30d:number, tierMix30d:{tier:number,lineItems:number,share:number}[],
 *   pagesPerOrder30d:number, weeklyTrend:{week:string,orders:number,revenue:number}[],
 *   currency:string, counted:number
 * }}
 */
export function computeMetrics(nodes, { now = new Date(), timeZone = 'Europe/Prague' } = {}) {
  const today = zonedDate(now, timeZone);
  const thisMonth = { y: today.y, m: today.m };
  const lastMonth = today.m === 1 ? { y: today.y - 1, m: 12 } : { y: today.y, m: today.m - 1 };
  const windowStart = now.getTime() - ROLLING_DAYS * DAY_MS;

  let ordersThisMonth = 0;
  let ordersLastMonth = 0;
  let revenueThisMonth = 0;
  let revenueLastMonth = 0;
  let orders30d = 0;
  let revenue30d = 0;
  let photos30d = 0;
  let currency = null;

  const tiers = new Map(); // photo count -> line items
  const weeks = new Map(); // "2026-W31" -> { orders, revenue }

  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node !== 'object') continue;
    if (!COUNTED.has(node.displayFinancialStatus)) continue;

    const created = node.createdAt ? new Date(node.createdAt) : null;
    if (!created || Number.isNaN(created.getTime())) continue; // undatable: it can join no window

    const amount = amountOf(node);
    currency ??= currencyOf(node);
    const at = zonedDate(created, timeZone);

    if (at.y === thisMonth.y && at.m === thisMonth.m) {
      ordersThisMonth++;
      revenueThisMonth += amount;
    } else if (at.y === lastMonth.y && at.m === lastMonth.m) {
      ordersLastMonth++;
      revenueLastMonth += amount;
    }

    const key = isoWeekKey(at);
    const bucket = weeks.get(key) ?? { orders: 0, revenue: 0 };
    bucket.orders++;
    bucket.revenue += amount;
    weeks.set(key, bucket);

    if (created.getTime() >= windowStart) {
      orders30d++;
      revenue30d += amount;
      for (const edge of node.lineItems?.edges ?? []) {
        const item = edge?.node;
        if (!item) continue;

        // THE MIX IS WHAT WAS SOLD. The tier comes from the variant title ("… / 8") — the thing the
        // customer chose and paid for — not from how many photos they got round to uploading. Those
        // differ on exactly the orders that are held for a short upload, and a mix that counted
        // those as a smaller tier would report the AOV fix losing ground every time somebody was
        // slow with their photos.
        const soldTier = expectedPhotosFrom([{ title: item.title ?? '', variant: item.variantTitle ?? '' }]);
        if (soldTier != null) tiers.set(soldTier, (tiers.get(soldTier) ?? 0) + 1);

        // Pages are what actually arrived, which is a different question: how much book the studio
        // is producing, not how much was bought. On a complete order the two agree.
        photos30d += lineItemPhotoCount(item);
      }
    }
  }

  const tierItems = [...tiers.values()].reduce((a, b) => a + b, 0);
  const tierMix30d = [...tiers.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tier, lineItems]) => ({ tier, lineItems, share: tierItems ? Math.round((lineItems / tierItems) * 1000) / 1000 : 0 }));

  // Every one of the last 12 weeks appears, including the quiet ones: a gap silently dropped from a
  // trend reads as "no data here" when it means "no orders that week", and those are opposite news.
  const weeklyTrend = [];
  for (let i = TREND_WEEKS - 1; i >= 0; i--) {
    const key = isoWeekKey(addDays(today, -7 * i));
    const bucket = weeks.get(key) ?? { orders: 0, revenue: 0 };
    weeklyTrend.push({ week: key, orders: bucket.orders, revenue: Math.round(bucket.revenue * 100) / 100 });
  }

  return {
    ordersThisMonth,
    ordersLastMonth,
    revenueThisMonth: Math.round(revenueThisMonth * 100) / 100,
    revenueLastMonth: Math.round(revenueLastMonth * 100) / 100,
    aov30d: mean2(revenue30d, orders30d),
    tierMix30d,
    pagesPerOrder30d: mean2(photos30d, orders30d),
    weeklyTrend,
    currency: currency ?? 'CZK',
    counted: orders30d,
    // Extension point: a second source (PostHog, Meta) becomes another key beside these, computed by
    // its own function over its own input — never another argument reshaping what is already here.
  };
}
