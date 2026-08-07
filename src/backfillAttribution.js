// Backfill "where did this order come from" onto the order folders that already exist.
//
// The homepage's recent-orders list draws its Zdroj column from the sidecar, written at download
// time. Every order downloaded before that field existed has none, so without this the column reads
// "bez zdroje" all the way down until the back catalogue ages out — technically true, useless in
// practice, and it makes a new column look broken rather than empty.
//
// The logic lives here rather than in the tool because the tool cannot reach the machine that
// matters. The studio runs on Render, where there is no shell to run a CLI in, so the same function
// is driven two ways: `tools/backfillAttribution.mjs` for a local checkout, and an operator-only
// route for the deployed instance.
//
// WHAT IT WILL AND WILL NOT TOUCH:
//
//   sidecar without `attribution`, order found     → patch `attribution` in, nothing else
//   sidecar already carrying `attribution`         → nothing (so re-running changes nothing)
//   order not found in Shopify                     → reported, skipped, never guessed at
//   Shopify lookup failed (throttled, down)        → counted separately from "not found", so a
//                                                    rate-limited run does not read as a shop
//                                                    missing half its orders
//   folder with no sidecar at all                  → skipped: there is no record to patch
//   sidecar unreadable or not an object            → reported and skipped, never overwritten
//
// It rewrites ONLY the `attribution` key, through a temp file and a rename. The sidecar also holds
// the dedication the customer typed and the address needed to reach them; `readOrderInfo` treats an
// unparseable sidecar as "no answer", so a torn write would lose both silently — the dedication
// reverting to a guess from photo filenames and the email simply gone.

import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { attributionFrom, channelOf } from './shopify/orders.js';
import { ORDER_INFO } from './orderInfo.js';

/** Every order folder under a root that actually has a sidecar to patch. */
function orderDirs(root) {
  if (!root || !existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ orderId: e.name, dir: join(root, e.name) }))
    .filter((o) => existsSync(join(o.dir, ORDER_INFO)));
}

/** The order number Shopify knows this folder by.
 *
 *  Read from the sidecar, which materialize.js already wrote — NOT derived by splitting the folder
 *  name on "-". A multi-book folder is "1563-5" and Shopify knows it as 1563, but an order whose
 *  own NAME contains a hyphen is a real case here (test/shopifyOrders.test.js pins "1524-9" as a
 *  name, not a suffix), and splitting it would ask Shopify for order 1524 and write another
 *  customer's channel onto this one. The split survives only for a folder written before the
 *  sidecar carried a purchase block. */
export function purchaseNumber(sidecar, folderName) {
  const fromSidecar = sidecar?.purchase?.orderId ?? sidecar?.order;
  if (typeof fromSidecar === 'string' && fromSidecar.trim()) return fromSidecar.trim();
  return String(folderName).split('-')[0];
}

/**
 * Patch attribution onto every order folder that lacks it.
 *
 * @param {object}   o
 * @param {object}   o.config      resolved config (paths.inbox / paths.outbox)
 * @param {object}   o.client      an admin client with `fetchOrderByName`
 * @param {boolean}  [o.write]     false (default) reports what would change and touches nothing
 * @param {function} [o.onLine]    per-folder progress line, for a CLI to print
 * @returns {Promise<{patched:number, already:number, unresolved:number, failed:number,
 *                    unreadable:number, lines:string[]}>}
 */
export async function backfillAttribution({ config, client, write = false, onLine = () => {} }) {
  const roots = [config?.paths?.inbox, config?.paths?.outbox].filter(Boolean);
  const seen = new Map(); // folder name -> [dirs], because a book exists in both inbox and outbox
  for (const root of roots) {
    for (const o of orderDirs(root)) {
      if (!seen.has(o.orderId)) seen.set(o.orderId, []);
      seen.get(o.orderId).push(o.dir);
    }
  }

  const counts = { patched: 0, already: 0, unresolved: 0, failed: 0, unreadable: 0, lines: [] };
  const say = (line) => { counts.lines.push(line); onLine(line); };

  // One lookup per purchase, shared by its books: a five-book order costs one query, not five.
  const cache = new Map();

  for (const [orderId, dirs] of [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }))) {
    for (const dir of dirs) {
      const path = join(dir, ORDER_INFO);
      let sidecar;
      try {
        sidecar = JSON.parse(readFileSync(path, 'utf8'));
      } catch (err) {
        say(`${orderId}: sidecar unreadable — skipped (${err.message})`);
        counts.unreadable++;
        continue;
      }
      // JSON.parse("null") succeeds; assigning onto that below would throw and take the whole run
      // down on one odd file, half-way through a backlog.
      if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
        say(`${orderId}: sidecar is not an object — skipped`);
        counts.unreadable++;
        continue;
      }
      if (sidecar.attribution) {
        counts.already++;
        continue;
      }

      const number = purchaseNumber(sidecar, orderId);
      if (!cache.has(number)) {
        try {
          const node = await client.fetchOrderByName(number);
          cache.set(number, node ? attributionFrom(node) : null);
        } catch (err) {
          say(`${orderId}: Shopify lookup failed — skipped (${err.message})`);
          cache.set(number, { failed: true });
        }
      }
      const attribution = cache.get(number);
      if (attribution?.failed) { counts.failed++; continue; }
      if (!attribution) {
        say(`${orderId}: not found in Shopify — skipped`);
        counts.unresolved++;
        continue;
      }

      const value = { ...attribution, channel: channelOf(attribution) };
      say(`${orderId}: ${value.channel}${value.campaign ? ' · ' + value.campaign : ''}${write ? '' : ' (dry run)'}`);
      if (write) {
        sidecar.attribution = value;
        const tmp = `${path}.tmp-${process.pid}`;
        writeFileSync(tmp, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
        renameSync(tmp, path);
      }
      counts.patched++;
    }
  }

  return counts;
}
