// What the shop knows about an order, written next to the photographs by the Chrome extension.
//
// Shopify holds the dedication the customer actually typed — "Pro Jiříčka", accents and all. The
// photo file names fold it to ASCII on the way out ("pro_jiricka"), and once folded no rule can
// put it back: "jiricka" is Jiříčka, Jiřička or Jiricka and the name cannot say which. So the
// extension now drops the real string into `objednavka.json` beside the photos, and this reads it.
//
// Everything here is best-effort. An order downloaded by an older extension has no such file, and
// a book must still be printable from the photographs alone — so a missing, unreadable or
// half-written file is not an error, it is simply no answer.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ORDER_INFO = 'objednavka.json';

export const orderInfoPath = (orderDir) => join(orderDir, ORDER_INFO);

/** The shop's own record for one order folder, or null when there is none to be had.
 *  Only fields this tool trusts are returned; anything of the wrong type is dropped. */
export function readOrderInfo(orderDir) {
  if (!orderDir) return null;
  const path = orderInfoPath(orderDir);
  if (!existsSync(path)) return null;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // a truncated write, or a file the operator opened and saved from Word
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const dedication = typeof parsed.dedication === 'string' ? parsed.dedication.trim() : '';
  const order = typeof parsed.order === 'string' ? parsed.order.trim() : '';
  // The product's expected photo count and the customer, both written by a newer extension. An
  // older download has neither, and that is not an error — the count check goes advisory and the
  // email greeting stays neutral. Only positive integers and non-empty strings are trusted.
  const expectedPhotos = Number.isInteger(parsed.expectedPhotos) && parsed.expectedPhotos > 0 ? parsed.expectedPhotos : null;
  return {
    dedication,
    order,
    expectedPhotos,
    purchase: parsePurchase(parsed.purchase, order),
    copies: Number.isInteger(parsed.copies) && parsed.copies > 0 ? parsed.copies : 1,
    customer: parseCustomer(parsed.customer),
    products: parseProducts(parsed.products),
  };
}

/** Which book of a purchase this folder is. One customer can buy several books in one checkout;
 *  each is its own order folder, and this is the thread back to the parcel they ship in.
 *
 *  An older download has no such field, and that is not an error — it reads as a lone book, which
 *  is what it was. A half-written or nonsensical value reads the same way rather than inventing a
 *  sibling that does not exist. */
function parsePurchase(raw, fallbackOrderId) {
  const lone = { orderId: fallbackOrderId, position: 1, of: 1 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return lone;
  const orderId = typeof raw.orderId === 'string' && raw.orderId.trim() ? raw.orderId.trim() : fallbackOrderId;
  const position = Number.isInteger(raw.position) && raw.position > 0 ? raw.position : 1;
  const of = Number.isInteger(raw.of) && raw.of > 0 ? raw.of : 1;
  // A position past the total is contradictory; trust neither and read it as a lone book.
  if (position > of) return lone;
  return { orderId, position, of };
}

/** The line items the shop sold on this order — title, variant and quantity — when a newer
 *  extension recorded them. This is what the per-order build format (U9) reads. An older download
 *  has none, and that is not an error: the format check then falls back to the config default. */
function parseProducts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    const variant = typeof p.variant === 'string' ? p.variant.trim() : '';
    const qty = Number.isInteger(p.qty) && p.qty > 0 ? p.qty : null;
    if (title || variant) out.push({ title, variant, qty });
  }
  return out;
}

/** The customer's surname and email, when the shop recorded them — for the title-page greeting is
 *  none of this tool's business, but a photo-request email is addressed to a person. */
function parseCustomer(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const surname = typeof c.surname === 'string' ? c.surname.trim() : '';
  const email = typeof c.email === 'string' ? c.email.trim() : '';
  return surname || email ? { surname, email } : null;
}

/** The title-page text the shop recorded, or '' — never a guess. */
export function shopDedication(orderDir) {
  return readOrderInfo(orderDir)?.dedication ?? '';
}

/** The print layout an order should build in (U9), derived from the product/variant the shop sold
 *  — the same `objednavka.json` the expected-count check reads. Returns the builder `mode` and
 *  whether it came from the format map: `mapped: false` means "no product/variant matched, so this
 *  fell back to the configured default" — a flag for the operator, never a silent guess, and never
 *  a block on the pipeline.
 *
 *  The fallback walks `delivery.format` (which validateConfig mirrors from the global builder mode)
 *  then the raw `builder.pdf.mode`, so an un-mapped order keeps building exactly as it does today
 *  even for a config that never set a delivery block. */
export function resolveFormat(orderInfo, config = {}) {
  const map = config?.delivery?.formatMap ?? {};
  const fallback = config?.delivery?.format ?? config?.builder?.pdf?.mode ?? 'gallery';
  for (const p of orderInfo?.products ?? []) {
    // The variant is the more specific key (size/format live there); the product title is the
    // coarser fallback. Whichever the operator keyed the map by wins.
    for (const key of [p.variant, p.title]) {
      if (key && Object.prototype.hasOwnProperty.call(map, key)) {
        return { mode: map[key], mapped: true };
      }
    }
  }
  return { mode: fallback, mapped: false };
}
