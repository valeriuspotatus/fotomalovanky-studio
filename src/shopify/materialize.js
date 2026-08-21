// Turn a normalized photo-bearing order (orders.js) into an on-disk order folder that the existing
// ingest.js accepts: photos named for id-recovery, plus the objednavka.json sidecar that
// orderInfo.js reads. This is the autopilot's stand-in for what the Chrome extension writes by hand.
//
// Format wiring (KTD9): the galerie-vs-full-page signal lives in the order's `layout` (the
// "Rozvržení" attribute), NOT the variant — the same variantTitle ships both layouts. So the
// sidecar's products carry a leading entry whose `variant` is the layout string; resolveFormat
// (orderInfo.js) then matches it against config.delivery.formatMap with no change to orderInfo.js.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { ORDER_INFO } from '../orderInfo.js';
import { expectedPhotosFrom, channelOf, sourceFingerprint } from './orders.js';
import { safeFetch as defaultSafeFetch } from './safeFetch.js';

/** organize.js only ingests .jpg/.jpeg (isPhoto), but the upload host serves some photos as PNG/WebP.
 *  Re-encode anything that isn't already JPEG so every downloaded photo reaches the pipeline instead
 *  of being silently skipped. Flatten onto white so a transparent PNG doesn't come through black. */
async function ensureJpeg(buffer, ext, sharpImpl) {
  if (/^jpe?g$/i.test(ext)) return { buffer, ext };
  const converted = await sharpImpl(buffer).flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer();
  return { buffer: converted, ext: 'jpeg' };
}

/** ingest.js recovers the id from "<order>_img<NNNN>_-_<label>.<ext>". Only the "<order>_img<NNNN>"
 *  prefix matters for id-recovery; the label is cosmetic, so a sanitized token is enough. */
function photoName(orderId, index, label, ext) {
  const nnnn = String(index + 1).padStart(4, '0');
  const safeLabel = (label || 'foto').normalize('NFKD').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'foto';
  return `${orderId}_img${nnnn}_-_${safeLabel}.${ext}`;
}

const SAFE_ORDER_ID = /^\d+(?:-\d+)*$/;

function containedOrderDir(inboxRoot, orderId) {
  if (!SAFE_ORDER_ID.test(String(orderId ?? ''))) throw new Error(`A safe order id is required: ${JSON.stringify(orderId)}`);
  const root = resolve(inboxRoot);
  const dir = resolve(root, String(orderId));
  const rel = relative(root, dir);
  if (!rel || rel.startsWith('..') || rel.includes(':')) throw new Error('A safe order id must stay inside the inbox');
  return { root, dir };
}

function validMaterialization(dir, orderId, fingerprint, expectedFiles) {
  try {
    const names = readdirSync(dir).sort();
    if (names.length !== expectedFiles.length + 1 || !names.includes(ORDER_INFO)) return false;
    if (!expectedFiles.every((name) => names.includes(name))) return false;
    const sidecar = JSON.parse(readFileSync(join(dir, ORDER_INFO), 'utf8'));
    return sidecar.order === orderId && sidecar.revision?.fingerprint === fingerprint && sidecar.photos?.length === expectedFiles.length;
  } catch { return false; }
}

/** Windows cannot atomically replace a non-empty directory. Move the known-good active revision
 * aside first, promote staging, then remove the backup; restore it if promotion fails. */
function promote(stagingDir, activeDir, backupDir) {
  const hadActive = existsSync(activeDir);
  try {
    if (hadActive) renameSync(activeDir, backupDir);
    renameSync(stagingDir, activeDir);
    if (hadActive) rmSync(backupDir, { recursive: true, force: true });
  } catch (err) {
    if (!existsSync(activeDir) && existsSync(backupDir)) renameSync(backupDir, activeDir);
    throw err;
  }
}

/** Materialize one job into `<inboxRoot>/<orderId>/`, where orderId is the job's id — the bare
 *  order number for a single-book purchase, suffixed "-1"/"-2" when the purchase holds several.
 *  Each book therefore gets its own folder, its own photos and its own sidecar, with no further
 *  work here: the folder name and the photo filenames already follow `order.orderId`.
 *
 *  Downloads every photo through the SSRF-guarded fetcher; a photo that cannot be fetched marks
 *  this job incomplete — not its sibling — rather than leaving a half folder that would mislead
 *  intake. Returns a result describing what landed. */
export async function materializeOrder(order, {
  inboxRoot,
  allowlist = [],
  safeFetch = defaultSafeFetch,
  fetchImpl = fetch,
  sharpImpl = sharp,
  now = () => new Date().toISOString(),
} = {}) {
  const { root, dir: orderDir } = containedOrderDir(inboxRoot, order.orderId);
  mkdirSync(root, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stagingDir = join(root, `.${order.orderId}.staging-${nonce}`);
  const backupDir = join(root, `.${order.orderId}.previous-${nonce}`);
  mkdirSync(stagingDir);
  const fingerprint = sourceFingerprint(order);

  const files = [];
  const errors = [];
  for (let i = 0; i < order.photos.length; i++) {
    const url = order.photos[i];
    try {
      const fetched = await safeFetch(url, { allowlist, fetchImpl });
      const { buffer, ext } = await ensureJpeg(fetched.buffer, fetched.ext, sharpImpl);
      const name = photoName(order.orderId, i, order.dedication, ext);
      writeFileSync(join(stagingDir, name), buffer);
      files.push(name);
    } catch (err) {
      errors.push(`photo ${i + 1}: ${err.message}`);
    }
  }

  const incomplete = errors.length > 0 || files.length === 0 || files.length !== order.photos.length;

  // The sidecar orderInfo.js reads. `products` leads with the format entry (KTD9), then the real
  // line items for the count/summary. `customer` carries the order email (recipient) with an empty
  // surname — read_orders yields no surname, which parseCustomer tolerates (neutral greeting).
  const products = [];
  if (order.layout) products.push({ title: 'Rozvržení', variant: order.layout, qty: null });
  for (const p of order.products) products.push(p);

  // `purchase` and `copies` are what tell the rest of the tool that this book has siblings, and how
  // many times to print it. Written here because nothing downstream re-reads Shopify — the board,
  // the dispatch warning and the per-purchase email all derive from this sidecar. An order object
  // built by hand (a manual pull, a test) has neither, and reads as a lone single-copy book.
  const sidecar = {
    order: order.orderId,
    purchase: order.purchase ?? { orderId: order.orderId, position: 1, of: 1 },
    copies: order.copies ?? 1,
    dedication: order.dedication,
    expectedPhotos: expectedPhotosFrom(order.products),
    customer: { surname: '', email: order.email },
    products,
    photos: order.photos,
    layout: order.layout,
    // Where the order came from, recorded once at download. The board reads it from here rather
    // than asking Shopify again: the aggregate on the homepage answers "how is the shop doing" for
    // a whole window, while this answers "where did THIS one come from" for a single row, and the
    // second question has no business re-pulling ninety days of orders to answer it.
    //
    // An order object built by hand — a manual pull, a test — carries none, and reads as unknown.
    attribution: order.attribution ? { ...order.attribution, channel: channelOf(order.attribution) } : null,
    source: 'shopify-admin-api',
    downloadedAt: now(),
    revision: { fingerprint, sourceUpdatedAt: order.updatedAt ?? null },
  };
  if (!incomplete) writeFileSync(join(stagingDir, ORDER_INFO), JSON.stringify(sidecar, null, 2));

  try {
    if (incomplete || !validMaterialization(stagingDir, order.orderId, fingerprint, files)) {
      if (!incomplete) errors.push('staged contents failed validation');
      return { orderId: order.orderId, orderDir, files: [], incomplete: true, errors, fingerprint };
    }
    promote(stagingDir, orderDir, backupDir);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }

  return { orderId: order.orderId, orderDir, files, incomplete: false, errors, fingerprint };
}
