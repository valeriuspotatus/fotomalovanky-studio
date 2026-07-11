// Pure normalization of a Shopify Admin API order node into the shape the autopilot pipeline
// needs. No I/O — given a raw GraphQL order node, it returns photos, dedication, format and
// recipient, extracted from the line-item custom attributes.
//
// The public Admin API returns `customAttributes` as `{ key, value }` — there is NO `type` field
// (that is admin-internal-only; see the U0 spike / KTD1). So extraction matches on the KEY
// substring, never on a type. Confirmed keys on the live store:
//   photos     — "Fotka (N)-M"   (N = total count, M = 1-based index)
//   dedication — "Věnování"
//   format     — "Rozvržení"     (the ONLY galerie-vs-full-page signal; not the variant — KTD9)
//   internal   — "_tpo_add_by"   (and any "_"-prefixed key) — skipped

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

/** All `{ key, value }` custom attributes across every line item, dropping "_"-prefixed internals. */
function customerAttributes(node) {
  const out = [];
  for (const le of node.lineItems?.edges ?? []) {
    for (const a of le.node?.customAttributes ?? []) {
      if (!a || typeof a.key !== 'string' || a.key.startsWith('_')) continue;
      out.push(a);
    }
  }
  return out;
}

/** Normalize one raw order node. Returns null only for a node with no usable id. */
export function extractOrder(node, opts = {}) {
  if (!node || typeof node !== 'object') return null;
  const { photoKeyMatch, dedicationKeyMatch, layoutKeyMatch } = { ...DEFAULTS, ...opts };

  const orderId = String(node.name ?? '').replace(/^#/, '').trim();
  if (!orderId) return null;

  const attrs = customerAttributes(node);

  const photos = attrs
    .filter((a) => keyIncludes(a.key, photoKeyMatch) && isUrl(a.value))
    .map((a) => ({ url: a.value, idx: photoIndex(a.key) }))
    .sort((x, y) => (x.idx ?? 1e9) - (y.idx ?? 1e9))
    .map((p) => p.url);

  const dedication = attrs.find((a) => keyIncludes(a.key, dedicationKeyMatch) && a.value)?.value?.trim() ?? '';
  const layout = attrs.find((a) => keyIncludes(a.key, layoutKeyMatch) && a.value)?.value?.trim() ?? '';

  const products = (node.lineItems?.edges ?? [])
    .map((le) => le.node)
    .filter(Boolean)
    .map((p) => ({
      title: (p.title ?? '').trim(),
      variant: (p.variantTitle ?? '').trim(),
      qty: Number.isInteger(p.quantity) && p.quantity > 0 ? p.quantity : null,
    }));

  return {
    orderId,
    updatedAt: node.updatedAt ?? null,
    financialStatus: node.displayFinancialStatus ?? null,
    email: (node.email ?? '').trim(),
    dedication,
    layout,
    photos,
    products,
  };
}

/** The photo count a "… / N" variant title advertises ("🖨️ Tištěné omalovánky / 4" -> 4), or null.
 *  Used to seed `expectedPhotos` so the intake count check is meaningful for autopilot orders. */
export function expectedPhotosFrom(products) {
  for (const p of products ?? []) {
    const m = /\/\s*(\d+)\s*$/.exec(p.variant || '');
    if (m) return Number(m[1]);
  }
  return null;
}
