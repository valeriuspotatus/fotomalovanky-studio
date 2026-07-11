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
  return { dedication, order, expectedPhotos, customer: parseCustomer(parsed.customer) };
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
