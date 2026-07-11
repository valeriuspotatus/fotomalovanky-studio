// Turn a normalized photo-bearing order (orders.js) into an on-disk order folder that the existing
// ingest.js accepts: photos named for id-recovery, plus the objednavka.json sidecar that
// orderInfo.js reads. This is the autopilot's stand-in for what the Chrome extension writes by hand.
//
// Format wiring (KTD9): the galerie-vs-full-page signal lives in the order's `layout` (the
// "Rozvržení" attribute), NOT the variant — the same variantTitle ships both layouts. So the
// sidecar's products carry a leading entry whose `variant` is the layout string; resolveFormat
// (orderInfo.js) then matches it against config.delivery.formatMap with no change to orderInfo.js.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORDER_INFO } from '../orderInfo.js';
import { expectedPhotosFrom } from './orders.js';
import { safeFetch as defaultSafeFetch } from './safeFetch.js';

/** ingest.js recovers the id from "<order>_img<NNNN>_-_<label>.<ext>". Only the "<order>_img<NNNN>"
 *  prefix matters for id-recovery; the label is cosmetic, so a sanitized token is enough. */
function photoName(orderId, index, label, ext) {
  const nnnn = String(index + 1).padStart(4, '0');
  const safeLabel = (label || 'foto').normalize('NFKD').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'foto';
  return `${orderId}_img${nnnn}_-_${safeLabel}.${ext}`;
}

/** Materialize one order into `<inboxRoot>/<orderId>/`. Downloads every photo through the
 *  SSRF-guarded fetcher; a photo that cannot be fetched marks the whole order incomplete rather
 *  than leaving a half folder that would mislead intake. Returns a result describing what landed. */
export async function materializeOrder(order, {
  inboxRoot,
  allowlist = [],
  safeFetch = defaultSafeFetch,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
} = {}) {
  const orderDir = join(inboxRoot, order.orderId);
  mkdirSync(orderDir, { recursive: true });

  const files = [];
  const errors = [];
  for (let i = 0; i < order.photos.length; i++) {
    const url = order.photos[i];
    try {
      const { buffer, ext } = await safeFetch(url, { allowlist, fetchImpl });
      const name = photoName(order.orderId, i, order.dedication, ext);
      writeFileSync(join(orderDir, name), buffer);
      files.push(name);
    } catch (err) {
      errors.push(`photo ${i + 1}: ${err.message}`);
    }
  }

  const incomplete = errors.length > 0 || files.length === 0;

  // The sidecar orderInfo.js reads. `products` leads with the format entry (KTD9), then the real
  // line items for the count/summary. `customer` carries the order email (recipient) with an empty
  // surname — read_orders yields no surname, which parseCustomer tolerates (neutral greeting).
  const products = [];
  if (order.layout) products.push({ title: 'Rozvržení', variant: order.layout, qty: null });
  for (const p of order.products) products.push(p);

  const sidecar = {
    order: order.orderId,
    dedication: order.dedication,
    expectedPhotos: expectedPhotosFrom(order.products),
    customer: { surname: '', email: order.email },
    products,
    photos: order.photos,
    layout: order.layout,
    source: 'shopify-admin-api',
    downloadedAt: now(),
  };
  writeFileSync(join(orderDir, ORDER_INFO), JSON.stringify(sidecar, null, 2));

  return { orderId: order.orderId, orderDir, files, incomplete, errors };
}
