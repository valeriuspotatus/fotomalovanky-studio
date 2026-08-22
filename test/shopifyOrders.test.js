import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJobs, expectedPhotosFrom, attributionFrom, channelOf } from '../src/shopify/orders.js';
import { DIGITAL_PERFORMANCE_KEYS, DIGITAL_PERFORMANCE_TEXT_HASH, DIGITAL_PERFORMANCE_VERSION, PHOTO_AUTHORIZATION_KEYS as KEYS, PHOTO_AUTHORIZATION_LOCALE, PHOTO_AUTHORIZATION_TEXT_HASH, PHOTO_AUTHORIZATION_VERSION } from '../src/photoAuthorization.js';

// The pure extraction from a real PUBLIC Admin API order node. The public API returns customAttributes
// as {key,value} with NO `type` field (the admin-internal `type:"URL"` is not present) — so extraction
// matches on the KEY substring only. These fixtures follow that real shape (KTD1), not injected.js's.

/** One line item — one book. */
function item({ variant = '🖨️ Tištěné omalovánky / 4', quantity = 1, attrs = [] } = {}) {
  return { node: { title: 'Fotomalovánky', variantTitle: variant, quantity, customAttributes: attrs } };
}

/** A raw order node. Defaults to a single line item; pass `items` for a multi-book purchase. */
function node({ name = '#1524', email = 'a@b.cz', financial = 'PAID', createdAt = '2026-08-22T10:00:00.000Z', updatedAt = '2026-07-12T01:00:00Z', variant = '🖨️ Tištěné omalovánky / 4', attrs = [], items = null } = {}) {
  return {
    name,
    email,
    createdAt,
    updatedAt,
    displayFinancialStatus: financial,
    lineItems: { edges: items ?? [item({ variant, attrs })] },
  };
}

/** The single job of a single-book purchase. */
const one = (opts) => extractJobs(node(opts))[0];

const CDN = 'https://cdn.tigren.com/media';
const photoAttrs = (n, prefix) => Array.from({ length: n }, (_, i) => ({ key: `Fotka (${n})-${i + 1}`, value: `${CDN}/${prefix}${i + 1}.jpg` }));
const consentAttrs = () => [
  { key: KEYS.accepted, value: 'true' },
  { key: KEYS.version, value: PHOTO_AUTHORIZATION_VERSION },
  { key: KEYS.acceptedAt, value: '2026-08-22T09:58:00.000Z' },
  { key: KEYS.locale, value: PHOTO_AUTHORIZATION_LOCALE },
  { key: KEYS.textHash, value: PHOTO_AUTHORIZATION_TEXT_HASH },
];

test('print and PDF books preserve the same exact authorization evidence per line item', () => {
  const items = [
    item({ variant: '🖨️ Tištěné omalovánky / 4', attrs: [...photoAttrs(1, 'print'), ...consentAttrs()] }),
    item({ variant: '💻 Pouze PDF online / 4', attrs: [...photoAttrs(1, 'pdf'), ...consentAttrs(),
      { key: DIGITAL_PERFORMANCE_KEYS.accepted, value: 'true' },
      { key: DIGITAL_PERFORMANCE_KEYS.acceptedAt, value: '2026-08-22T09:59:00.000Z' },
      { key: DIGITAL_PERFORMANCE_KEYS.version, value: DIGITAL_PERFORMANCE_VERSION },
      { key: DIGITAL_PERFORMANCE_KEYS.locale, value: PHOTO_AUTHORIZATION_LOCALE },
      { key: DIGITAL_PERFORMANCE_KEYS.textHash, value: DIGITAL_PERFORMANCE_TEXT_HASH }] }),
  ];
  const jobs = extractJobs(node({ items }));
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((job) => job.photoAuthorization.valid));
  assert.ok(jobs.every((job) => job.photoAuthorization.evidence.textHash === PHOTO_AUTHORIZATION_TEXT_HASH));
  assert.ok(jobs.every((job) => job.photoAuthorization.evidence.orderTimestamp === '2026-08-22T10:00:00.000Z'));
  assert.equal(jobs[0].digitalPerformance.evidence, null);
  assert.equal(jobs[1].digitalPerformance.evidence.accepted, true);
});

test('a PDF line item without separate immediate-performance evidence fails closed', () => {
  const job = one({ variant: 'Pouze PDF online / 4', attrs: [...photoAttrs(1, 'pdf'), ...consentAttrs()] });
  assert.equal(job.photoAuthorization.valid, true);
  assert.equal(job.digitalPerformance.valid, false);
});

test('a real 4-photo order extracts the URL photos index-ordered, the dedication, the layout and the recipient', () => {
  const o = one({
    attrs: [
      { key: 'Fotka (4)-1', value: `${CDN}/one.jpg` },
      { key: 'Fotka (4)-2', value: '' }, // a slot the customer left empty — not a URL, dropped
      { key: 'Fotka (4)-3', value: `${CDN}/three.jpg` },
      { key: 'Fotka (4)-4', value: 'not-a-url' },
      { key: 'Věnování', value: 'Pro Klárku' },
      { key: 'Rozvržení', value: '🖼️ Galerie (vaše fotka vedle omalovánky)' },
      { key: '_tpo_add_by', value: 'tigren-internal' },
    ],
  });
  assert.equal(o.orderId, '1524', 'the # is stripped from the customer-facing name');
  assert.deepEqual(o.photos, [`${CDN}/one.jpg`, `${CDN}/three.jpg`], 'only URL values, ordered by the trailing -M index');
  assert.equal(o.dedication, 'Pro Klárku');
  assert.equal(o.layout, '🖼️ Galerie (vaše fotka vedle omalovánky)');
  assert.equal(o.email, 'a@b.cz');
  assert.equal(o.financialStatus, 'PAID');
  assert.equal(o.products[0].variant, '🖨️ Tištěné omalovánky / 4', 'the real variant title is kept for the count/summary');
});

test('the layout comes from the Rozvržení attribute, not the variant (KTD9): the same variant ships both', () => {
  const galerie = one({ attrs: [{ key: 'Fotka (1)-1', value: `${CDN}/a.jpg` }, { key: 'Rozvržení', value: '🖼️ Galerie (vaše fotka vedle omalovánky)' }] });
  const full = one({ attrs: [{ key: 'Fotka (1)-1', value: `${CDN}/a.jpg` }, { key: 'Rozvržení', value: '📄 Celostránková omalovánka (plná stránka pro vybarvování)' }] });
  assert.match(galerie.layout, /Galerie/);
  assert.match(full.layout, /Celostránková/);
});

test('photos out of attribute order are still returned in customer upload order', () => {
  const o = one({ attrs: [
    { key: 'Fotka (3)-3', value: `${CDN}/c.jpg` },
    { key: 'Fotka (3)-1', value: `${CDN}/a.jpg` },
    { key: 'Fotka (3)-2', value: `${CDN}/b.jpg` },
  ] });
  assert.deepEqual(o.photos, [`${CDN}/a.jpg`, `${CDN}/b.jpg`, `${CDN}/c.jpg`]);
});

test('attributes carry NO `type` field and photos are still extracted by key match (internal-vs-public regression guard)', () => {
  const o = one({ attrs: [{ key: 'Fotka (1)-1', value: `${CDN}/a.jpg` }] });
  assert.deepEqual(o.photos, [`${CDN}/a.jpg`], 'a public-shape {key,value} with no type must still yield the photo');
});

test('a book whose customer uploaded nothing still yields a job, so the count gate can hold it', () => {
  const jobs = extractJobs(node({ attrs: [{ key: 'Věnování', value: 'x' }] }));
  assert.equal(jobs.length, 1, 'the variant advertises 4 photos, so this is a book — an empty one');
  assert.deepEqual(jobs[0].photos, []);
});

test('a missing dedication, layout or email degrades to empty strings, not a crash', () => {
  const o = one({ email: '', attrs: [{ key: 'Fotka (1)-1', value: `${CDN}/a.jpg` }] });
  assert.equal(o.dedication, '');
  assert.equal(o.layout, '');
  assert.equal(o.email, '');
});

test('a node with no usable name yields no jobs', () => {
  assert.deepEqual(extractJobs(node({ name: '' })), []);
  assert.deepEqual(extractJobs(null), []);
});

test('expectedPhotosFrom reads the "… / N" count off the variant title', () => {
  assert.equal(expectedPhotosFrom([{ variant: '🖨️ Tištěné omalovánky / 4' }]), 4);
  assert.equal(expectedPhotosFrom([{ variant: 'no count here' }]), null);
  assert.equal(expectedPhotosFrom([]), null);
});

// --- one purchase, several books ---------------------------------------------------------------

test('two line items of the same product become two jobs, each holding only its own photos', () => {
  const jobs = extractJobs(node({
    name: '#1234',
    items: [
      item({ variant: '🖨️ Tištěné omalovánky / 8', attrs: photoAttrs(8, 'a') }),
      item({ variant: '🖨️ Tištěné omalovánky / 8', attrs: photoAttrs(8, 'b') }),
    ],
  }));
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((j) => j.orderId), ['1234-1', '1234-2']);
  assert.deepEqual(jobs[0].photos, photoAttrs(8, 'a').map((a) => a.value), 'the first book holds its own eight, in its own upload order');
  assert.deepEqual(jobs[1].photos, photoAttrs(8, 'b').map((a) => a.value), 'the second book holds its own eight, not a merge');
  // The bug this exists to stop: a flattened set sorts on colliding indices and interleaves.
  assert.ok(!jobs[0].photos.some((p) => p.includes('/b')), 'no photo of the second book leaks into the first');
});

test('each book carries its own purchase position, so the parcel stays visible', () => {
  const jobs = extractJobs(node({ name: '#1234', items: [item({ attrs: photoAttrs(2, 'a') }), item({ attrs: photoAttrs(2, 'b') })] }));
  assert.deepEqual(jobs[0].purchase, { orderId: '1234', position: 1, of: 2 });
  assert.deepEqual(jobs[1].purchase, { orderId: '1234', position: 2, of: 2 });
});

test('two books of the identical photo set each keep the full set — neither is deduplicated away', () => {
  const same = photoAttrs(8, 'same');
  const jobs = extractJobs(node({ name: '#1234', items: [item({ attrs: same }), item({ attrs: same })] }));
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].photos.length, 8);
  assert.equal(jobs[1].photos.length, 8);
  assert.deepEqual(jobs[0].photos, jobs[1].photos, 'identical uploads stay identical — two books of the same photos is a real order');
});

test('each book keeps its own dedication and layout; the first no longer wins for both', () => {
  const jobs = extractJobs(node({
    name: '#1234',
    items: [
      item({ attrs: [...photoAttrs(2, 'a'), { key: 'Věnování', value: 'Pro Adélku' }, { key: 'Rozvržení', value: '🖼️ Galerie' }] }),
      item({ attrs: [...photoAttrs(2, 'b'), { key: 'Věnování', value: 'Pro Kevina' }, { key: 'Rozvržení', value: '📄 Celostránková' }] }),
    ],
  }));
  assert.equal(jobs[0].dedication, 'Pro Adélku');
  assert.equal(jobs[1].dedication, 'Pro Kevina', "the second book's dedication is no longer discarded");
  assert.match(jobs[0].layout, /Galerie/);
  assert.match(jobs[1].layout, /Celostránková/);
});

test('each book expects its own photo count; the first line item does not set it for both', () => {
  const jobs = extractJobs(node({
    name: '#1234',
    items: [
      item({ variant: '🖨️ Tištěné omalovánky / 8', attrs: photoAttrs(8, 'a') }),
      item({ variant: '🖨️ Tištěné omalovánky / 4', attrs: photoAttrs(4, 'b') }),
    ],
  }));
  assert.equal(expectedPhotosFrom(jobs[0].products), 8);
  assert.equal(expectedPhotosFrom(jobs[1].products), 4);
});

test('a single-book purchase keeps the bare order number, exactly as before the split existed', () => {
  const jobs = extractJobs(node({ name: '#1524', attrs: photoAttrs(4, 'a') }));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].orderId, '1524', 'no suffix — nothing already on disk is renamed');
  assert.deepEqual(jobs[0].purchase, { orderId: '1524', position: 1, of: 1 });
});

test('quantity is copies of one book, not two books', () => {
  const jobs = extractJobs(node({ items: [item({ quantity: 2, attrs: photoAttrs(4, 'a') })] }));
  assert.equal(jobs.length, 1, 'one job — generating it twice would pay the model cost twice for identical output');
  assert.equal(jobs[0].copies, 2);
  assert.equal(jobs[0].orderId, '1524', 'copies do not suffix the id');
});

test('quantity absent or nonsensical still means one copy', () => {
  assert.equal(extractJobs(node({ items: [item({ quantity: 0, attrs: photoAttrs(1, 'a') })] }))[0].copies, 1);
  assert.equal(one({ attrs: photoAttrs(1, 'a') }).copies, 1);
});

test('a line item that is not a book yields no job, so postage never becomes a folder', () => {
  const jobs = extractJobs(node({
    name: '#1234',
    items: [
      item({ attrs: photoAttrs(4, 'a') }),
      item({ variant: 'Doprava', quantity: 1, attrs: [] }), // no photos, no "/ N" count
    ],
  }));
  assert.equal(jobs.length, 1, 'only the book becomes a job');
  assert.equal(jobs[0].orderId, '1234', 'and with one book it keeps the bare number, not "-1"');
});

test('a purchase of nothing book-shaped yields no jobs at all', () => {
  assert.deepEqual(extractJobs(node({ items: [item({ variant: 'Doprava', attrs: [] })] })), []);
});

test('an order name that already contains a hyphen does not collide with a position suffix', () => {
  const single = extractJobs(node({ name: '#1524-9', attrs: photoAttrs(2, 'a') }));
  assert.equal(single[0].orderId, '1524-9', 'a hyphenated name is preserved untouched when there is one book');
  const split = extractJobs(node({ name: '#1524-9', items: [item({ attrs: photoAttrs(2, 'a') }), item({ attrs: photoAttrs(2, 'b') })] }));
  assert.deepEqual(split.map((j) => j.orderId), ['1524-9-1', '1524-9-2'], 'suffixes append rather than overwrite');
  assert.equal(new Set(split.map((j) => j.orderId)).size, 2, 'the ids stay unique, which is what every order-keyed consumer relies on');
});

// ---- where the order came from ---------------------------------------------------------------
// Fixtures are the real shapes the live store returns, taken from orders 1560-1565 on 2026-08-06.
// The point of these is that the shop already knows the answer: no pixel, no second integration.

/** A journey summary in the API's own shape. `utm` null means the visit carried no UTM parameters. */
const journey = (source, utm = null) => ({
  customerJourneySummary: { firstVisit: { source, utmParameters: utm } },
});

test('a paid Meta click keeps its campaign and reads as paid', () => {
  const a = attributionFrom(journey('https://facebook.com/', { source: 'facebook', medium: 'paid', campaign: 'A+ sales - 3-2026' }));
  assert.deepEqual(a, { source: 'facebook', medium: 'paid', campaign: 'A+ sales - 3-2026' });
  assert.equal(channelOf(a), 'paid');
});

test('the same account also stamps cpc, and that is paid too', () => {
  // Both spellings arrive from the one Meta account; keying on "paid" alone would file half the ad
  // spend as if nobody had paid for it.
  const a = attributionFrom(journey('Facebook', { source: 'facebook', medium: 'cpc', campaign: 'A+ sales' }));
  assert.equal(channelOf(a), 'paid');
});

test('an unpaid search click reads as organic, whether the source is a name or a URL', () => {
  const google = attributionFrom(journey('Google'));
  assert.deepEqual(google, { source: 'Google', medium: null, campaign: null });
  assert.equal(channelOf(google), 'organic');
  assert.equal(channelOf(attributionFrom(journey('https://search.seznam.cz/'))), 'organic', 'Seznam arrives as a URL');
});

test('direct is direct', () => {
  assert.equal(channelOf(attributionFrom(journey('direct'))), 'direct');
});

test('an order with no journey data reads as unknown and does not throw', () => {
  assert.deepEqual(attributionFrom({}), { source: null, medium: null, campaign: null });
  assert.equal(channelOf(attributionFrom({})), 'unknown');
  assert.equal(channelOf(attributionFrom(null)), 'unknown');
  assert.equal(channelOf(attributionFrom({ customerJourneySummary: { firstVisit: null } })), 'unknown');
  assert.equal(channelOf(null), 'unknown', 'and a missing attribution object is unknown, not a crash');
});

test('an unpromoted social click is "other", so it cannot inflate the organic figure', () => {
  // The organic tile is the page's argument that free traffic outperforms bought traffic. An
  // Instagram post click is free, but it is not search, and lumping it in would flatter that
  // argument with revenue the blog and SEO work did not earn.
  const a = attributionFrom(journey('Instagram'));
  assert.equal(channelOf(a), 'other');
  assert.notEqual(channelOf(a), 'organic');
});

test('the extractor carries no referrer and no landing page', () => {
  // Both are available on the API and deliberately unread: a referrer can hold a query string, and
  // this data reaches an on-disk cache and the operator's screen.
  const a = attributionFrom({
    customerJourneySummary: {
      firstVisit: {
        source: 'Google',
        referrerUrl: 'https://www.google.com/search?q=omalovanky+z+fotky',
        landingPage: 'https://fotomalovanky.cz/?utm_content=secret',
        utmParameters: null,
      },
    },
  });
  assert.deepEqual(Object.keys(a).sort(), ['campaign', 'medium', 'source']);
  assert.ok(!JSON.stringify(a).includes('search?q='), 'no referrer survives extraction');
  assert.ok(!JSON.stringify(a).includes('utm_content'), 'no landing page survives extraction');
});
