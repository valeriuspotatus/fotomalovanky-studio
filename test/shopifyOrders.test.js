import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOrder, expectedPhotosFrom } from '../src/shopify/orders.js';

// The pure extraction from a real PUBLIC Admin API order node. The public API returns customAttributes
// as {key,value} with NO `type` field (the admin-internal `type:"URL"` is not present) — so extraction
// matches on the KEY substring only. These fixtures follow that real shape (KTD1), not injected.js's.

/** A raw order node with the given custom attributes on a single line item. */
function node({ name = '#1524', email = 'a@b.cz', financial = 'PAID', updatedAt = '2026-07-12T01:00:00Z', variant = '🖨️ Tištěné omalovánky / 4', attrs = [] } = {}) {
  return {
    name,
    email,
    updatedAt,
    displayFinancialStatus: financial,
    lineItems: { edges: [{ node: { title: 'Fotomalovánky', variantTitle: variant, quantity: 1, customAttributes: attrs } }] },
  };
}

const CDN = 'https://cdn.tigren.com/media';

test('a real 4-photo order extracts the URL photos index-ordered, the dedication, the layout and the recipient', () => {
  const o = extractOrder(
    node({
      attrs: [
        { key: 'Fotka (4)-1', value: `${CDN}/one.jpg` },
        { key: 'Fotka (4)-2', value: '' }, // a slot the customer left empty — not a URL, dropped
        { key: 'Fotka (4)-3', value: `${CDN}/three.jpg` },
        { key: 'Fotka (4)-4', value: 'not-a-url' },
        { key: 'Věnování', value: 'Pro Klárku' },
        { key: 'Rozvržení', value: '🖼️ Galerie (vaše fotka vedle omalovánky)' },
        { key: '_tpo_add_by', value: 'tigren-internal' },
      ],
    }),
  );
  assert.equal(o.orderId, '1524', 'the # is stripped from the customer-facing name');
  assert.deepEqual(o.photos, [`${CDN}/one.jpg`, `${CDN}/three.jpg`], 'only URL values, ordered by the trailing -M index');
  assert.equal(o.dedication, 'Pro Klárku');
  assert.equal(o.layout, '🖼️ Galerie (vaše fotka vedle omalovánky)');
  assert.equal(o.email, 'a@b.cz');
  assert.equal(o.financialStatus, 'PAID');
  assert.equal(o.products[0].variant, '🖨️ Tištěné omalovánky / 4', 'the real variant title is kept for the count/summary');
});

test('the layout comes from the Rozvržení attribute, not the variant (KTD9): the same variant ships both', () => {
  const galerie = extractOrder(node({ attrs: [{ key: 'Fotka (1)-1', value: `${CDN}/a.jpg` }, { key: 'Rozvržení', value: '🖼️ Galerie (vaše fotka vedle omalovánky)' }] }));
  const full = extractOrder(node({ attrs: [{ key: 'Fotka (1)-1', value: `${CDN}/a.jpg` }, { key: 'Rozvržení', value: '📄 Celostránková omalovánka (plná stránka pro vybarvování)' }] }));
  assert.match(galerie.layout, /Galerie/);
  assert.match(full.layout, /Celostránková/);
});

test('photos out of attribute order are still returned in customer upload order', () => {
  const o = extractOrder(node({ attrs: [
    { key: 'Fotka (3)-3', value: `${CDN}/c.jpg` },
    { key: 'Fotka (3)-1', value: `${CDN}/a.jpg` },
    { key: 'Fotka (3)-2', value: `${CDN}/b.jpg` },
  ] }));
  assert.deepEqual(o.photos, [`${CDN}/a.jpg`, `${CDN}/b.jpg`, `${CDN}/c.jpg`]);
});

test('attributes carry NO `type` field and photos are still extracted by key match (internal-vs-public regression guard)', () => {
  const o = extractOrder(node({ attrs: [{ key: 'Fotka (1)-1', value: `${CDN}/a.jpg` }] }));
  assert.deepEqual(o.photos, [`${CDN}/a.jpg`], 'a public-shape {key,value} with no type must still yield the photo');
});

test('an order with no photo attributes normalizes to photos:[] so the runner filters it out (R10)', () => {
  const o = extractOrder(node({ attrs: [{ key: 'Věnování', value: 'x' }] }));
  assert.deepEqual(o.photos, []);
});

test('a missing dedication, layout or email degrades to empty strings, not a crash', () => {
  const o = extractOrder(node({ email: '', attrs: [{ key: 'Fotka (1)-1', value: `${CDN}/a.jpg` }] }));
  assert.equal(o.dedication, '');
  assert.equal(o.layout, '');
  assert.equal(o.email, '');
});

test('a node with no usable name is dropped (null)', () => {
  assert.equal(extractOrder(node({ name: '' })), null);
  assert.equal(extractOrder(null), null);
});

test('expectedPhotosFrom reads the "… / N" count off the variant title', () => {
  assert.equal(expectedPhotosFrom([{ variant: '🖨️ Tištěné omalovánky / 4' }]), 4);
  assert.equal(expectedPhotosFrom([{ variant: 'no count here' }]), null);
  assert.equal(expectedPhotosFrom([]), null);
});
