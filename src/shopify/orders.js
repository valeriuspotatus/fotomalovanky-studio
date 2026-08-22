// Pure normalization of a Shopify Admin API order node into the jobs the autopilot pipeline needs.
// No I/O — given a raw GraphQL order node, it returns one job per book, each with its own photos,
// dedication, format and recipient, extracted from that book's line-item custom attributes.
//
// One line item is one book. Attributes are read per line item and never merged across them: the
// photo index below is local to its line item, so a flattened set has two photos claiming index 1
// and sorting interleaves the books instead of separating them.
//
// The public Admin API returns `customAttributes` as `{ key, value }` — there is NO `type` field
// (that is admin-internal-only; see the U0 spike / KTD1). So extraction matches on the KEY
// substring, never on a type. Confirmed keys on the live store:
//   photos     — "Fotka (N)-M"   (N = total count, M = 1-based index)
//   dedication — "Věnování"
//   format     — "Rozvržení"     (the ONLY galerie-vs-full-page signal; not the variant — KTD9)
//   internal   — "_tpo_add_by"   (and any "_"-prefixed key) — skipped

import { validateDigitalPerformance, validatePhotoAuthorization } from '../photoAuthorization.js';

const DEFAULTS = Object.freeze({
  photoKeyMatch: 'fotka',
  dedicationKeyMatch: 'věnování',
  layoutKeyMatch: 'rozvržení',
});

const isUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);
const keyIncludes = (key, needle) => key.toLowerCase().includes(needle.toLowerCase());

/** The trailing "-M" index in a photo key ("Fotka (4)-2" -> 2), or null when there is none.
 *  Photos are ordered by it so the book pages follow the customer's upload order, not the
 *  order the attributes happened to arrive in. */
function photoIndex(key) {
  const m = /-(\d+)\s*$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** One line item's `{ key, value }` custom attributes, dropping "_"-prefixed internals.
 *
 *  Scoped to a single line item on purpose. Flattening every line item's attributes into one array
 *  is what fused a two-book purchase into one job: the photo indices below are local to their line
 *  item, so a merged set has two photos claiming index 1, two claiming index 2, and so on. */
function lineItemAttributes(item) {
  const out = [];
  for (const a of item?.customAttributes ?? []) {
    if (!a || typeof a.key !== 'string' || a.key.startsWith('_')) continue;
    out.push(a);
  }
  return out;
}

/** One line item's photo URLs, ordered by the trailing "-M" index so the book's pages follow the
 *  customer's upload order. Only meaningful within a single line item: sorting a merged set
 *  interleaves the two books (Array.sort is stable, so equal indices keep insertion order) rather
 *  than concatenating them. */
function photosFrom(attrs, photoKeyMatch) {
  return attrs
    .filter((a) => keyIncludes(a.key, photoKeyMatch) && isUrl(a.value))
    .map((a) => ({ url: a.value, idx: photoIndex(a.key) }))
    .sort((x, y) => (x.idx ?? 1e9) - (y.idx ?? 1e9))
    .map((p) => p.url);
}

/** The one line item, shaped for the sidecar. Kept as a single-entry array because that is what
 *  `expectedPhotosFrom` and the sidecar's `products` field already consume. */
function productFrom(item) {
  return {
    title: (item.title ?? '').trim(),
    variant: (item.variantTitle ?? '').trim(),
    qty: Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : null,
  };
}

/** Normalize one raw order node into one job per book.
 *
 *  A single purchase can hold more than one book: the customer adds the product twice, uploads a
 *  photo set to each, and checks out once. Each line item is a separate book with its own photos,
 *  its own dedication and its own layout, so each becomes its own job — its own folder, its own
 *  PDF. Quantity is NOT a book count: quantity 2 means print the same book twice, so it rides
 *  along as `copies` rather than splitting (generating it twice would pay the model cost twice
 *  for byte-identical output).
 *
 *  A line item that carries neither photos nor an advertised "… / N" count is not a book — postage
 *  and add-ons yield no job. A book whose customer uploaded nothing still yields a job, because its
 *  variant advertises a count; the intake gate then holds it, which is the whole point of having
 *  the count.
 *
 *  Job ids: a purchase that yields one job keeps the bare order number, exactly as it did before
 *  this split existed, so nothing already on disk is renamed and single-book orders are
 *  indistinguishable from before. Only a purchase that yields several suffixes them "-1", "-2" —
 *  which also keeps the ids unique, so every consumer that keys on the order number (the boards,
 *  the manifest, retention, the autopilot's handled map) keeps working untouched.
 *
 *  Returns [] for a node with no usable id. */
export function extractJobs(node, opts = {}) {
  if (!node || typeof node !== 'object') return [];
  const { photoKeyMatch, dedicationKeyMatch, layoutKeyMatch } = { ...DEFAULTS, ...opts };

  const purchaseId = String(node.name ?? '').replace(/^#/, '').trim();
  if (!purchaseId) return [];

  const books = [];
  for (const le of node.lineItems?.edges ?? []) {
    const item = le?.node;
    if (!item) continue;
    const attrs = lineItemAttributes(item);
    const photos = photosFrom(attrs, photoKeyMatch);
    const product = productFrom(item);
    // Not a book: no photos and no advertised count. Postage, an add-on, a gift note.
    if (!photos.length && expectedPhotosFrom([product]) == null) continue;
    books.push({
      photos,
      product,
      dedication: attrs.find((a) => keyIncludes(a.key, dedicationKeyMatch) && a.value)?.value?.trim() ?? '',
      layout: attrs.find((a) => keyIncludes(a.key, layoutKeyMatch) && a.value)?.value?.trim() ?? '',
      copies: product.qty ?? 1,
      photoAuthorization: validatePhotoAuthorization(item.customAttributes, { orderCreatedAt: node.createdAt }),
      digitalPerformance: validateDigitalPerformance(item.customAttributes, { required: isDigitalProduct(product), orderCreatedAt: node.createdAt }),
    });
  }
  if (!books.length) return [];

  // One purchase is one visit, so every book of a multi-book purchase shares its attribution.
  const attribution = attributionFrom(node);

  const of = books.length;
  return books.map((b, i) => ({
    orderId: of === 1 ? purchaseId : `${purchaseId}-${i + 1}`,
    purchase: { orderId: purchaseId, position: i + 1, of },
    copies: b.copies,
    attribution,
    updatedAt: node.updatedAt ?? null,
    financialStatus: node.displayFinancialStatus ?? null,
    email: (node.email ?? '').trim(),
    dedication: b.dedication,
    layout: b.layout,
    photos: b.photos,
    products: [b.product],
    photoAuthorization: b.photoAuthorization,
    digitalPerformance: b.digitalPerformance,
  }));
}

const isDigitalProduct = (product) => /\bPDF\b/i.test(`${product.title} ${product.variant}`);

// ---- where the order came from --------------------------------------------------------------
//
// The shop already records this. `customerJourneySummary.firstVisit` carries the UTM parameters the
// ad platform appended and, failing that, a name derived from the referrer — so the studio can say
// which orders paid advertising produced without a tracking pixel, a second integration, or any
// cooperation from the ad account. Confirmed live: order 1565 arrives as facebook / paid /
// "A+ sales - 3-2026", 1562 as direct, 1560 with no journey data at all.
//
// `landingPage` and `referrerUrl` are not read here even though the API offers them. A referrer can
// carry a query string, this data reaches an on-disk cache and an operator's screen, and nothing the
// studio shows needs either field.

/** Media that mean somebody paid for the click. Shopify passes the ad platform's own `utm_medium`
 *  through untouched, and the live store shows both spellings from the same Meta account. */
const PAID_MEDIA = new Set(['paid', 'cpc', 'ppc', 'paid_social', 'paidsocial', 'paid-social']);

/** Search engines whose unpaid clicks are the "organic" the dashboard reports. Matched as a
 *  substring because the source arrives both as a bare name ("Google") and as a URL
 *  ("https://search.seznam.cz/"). */
const SEARCH_SOURCES = ['google', 'seznam', 'bing', 'duckduckgo', 'yahoo', 'ecosia'];

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/** One order's first-visit attribution: `{ source, medium, campaign }`, each null when absent.
 *  UTM parameters win over the referrer-derived source — they are what the ad platform actually
 *  stamped on the link, where the referrer is whatever the browser happened to send. */
export function attributionFrom(node) {
  const visit = node?.customerJourneySummary?.firstVisit;
  const utm = visit?.utmParameters;
  return {
    source: clean(utm?.source) || clean(visit?.source) || null,
    medium: clean(utm?.medium) || null,
    campaign: clean(utm?.campaign) || null,
  };
}

/** Which column of the dashboard an order belongs in.
 *
 *  `other` exists so the organic figure stays honest. An unpromoted Instagram or Facebook click is
 *  neither paid nor search, and folding it into organic would inflate the one number the page uses
 *  to argue that free traffic outperforms bought traffic. It sits with direct and unattributed,
 *  outside both tiles, where it cannot flatter either. */
export function channelOf(attribution) {
  const source = (attribution?.source ?? '').toLowerCase();
  const medium = (attribution?.medium ?? '').toLowerCase();
  if (PAID_MEDIA.has(medium)) return 'paid';
  if (!source) return 'unknown';
  if (SEARCH_SOURCES.some((s) => source.includes(s))) return 'organic';
  if (source === 'direct') return 'direct';
  return 'other';
}

/** The photo count a "… / N" variant title advertises ("🖨️ Tištěné omalovánky / 4" -> 4), or null.
 *  Used to seed `expectedPhotos` so the intake count check is meaningful for autopilot orders.
 *
 *  Takes the first match, which is exact now that `products` holds one job's own line item. It was
 *  not before: fed a whole purchase, two line items of 8 reported 8 against 16 merged photos, so
 *  the check that should have caught the merge under-reported it instead. */
export function expectedPhotosFrom(products) {
  for (const p of products ?? []) {
    const m = /\/\s*(\d+)\s*$/.exec(p.variant || '');
    if (m) return Number(m[1]);
  }
  return null;
}

/** How many photos ONE line item carries — the tier the customer bought, straight from the
 *  "Fotka (N)-M" attributes rather than from the variant title.
 *
 *  Exported for the metrics aggregation, which wants the count and nothing else. It runs the same
 *  two helpers extractJobs runs, so there is no second copy of "what counts as a photo attribute"
 *  to drift: change how a photo key is recognised and the sidecar and the dashboard move together.
 *  The variant title is deliberately not consulted — `expectedPhotosFrom` reads what was ADVERTISED,
 *  this reads what actually arrived, and a short upload is exactly the case where they differ. */
export function lineItemPhotoCount(item, opts = {}) {
  const { photoKeyMatch } = { ...DEFAULTS, ...opts };
  return photosFrom(lineItemAttributes(item), photoKeyMatch).length;
}
