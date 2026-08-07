// Backfill "where did this order come from" onto the order folders that already exist.
//
// The homepage's recent-orders list draws its Zdroj column from the sidecar, written at download
// time. Every order downloaded before that field existed has none, so on the day this ships the
// list would read "bez zdroje" all the way down — technically true, useless in practice, and it
// would make the new column look broken rather than empty.
//
// So: read the folders, ask Shopify what it recorded for each, and patch the one field in.
//
// WHAT IT WILL AND WILL NOT TOUCH:
//
//   sidecar without `attribution`, order found     → patch `attribution` in, nothing else
//   sidecar already carrying `attribution`         → nothing (so re-running changes nothing)
//   order not found in Shopify                     → reported, skipped, never guessed at
//   folder with no sidecar at all                  → skipped: there is no record to patch
//   sidecar unreadable                             → reported and skipped, never overwritten
//
// It rewrites ONLY the `attribution` key. The sidecar holds the dedication the customer typed and
// the address to email them; a migration that reserialized the whole object would be one bug away
// from rewriting either. Read, set one key, write back.
//
// Not wired into the autopilot. This is a one-shot the operator runs once, by hand:
//
//   node tools/backfillAttribution.mjs           # say what would change, touch nothing
//   node tools/backfillAttribution.mjs --write   # do it

import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createAdminClient } from '../src/shopify/adminClient.js';
import { attributionFrom, channelOf } from '../src/shopify/orders.js';
import { ORDER_INFO } from '../src/orderInfo.js';

const write = process.argv.includes('--write');
const config = loadConfig();

/** Every order folder under a root, by folder name. */
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
 *  own NAME contains a hyphen is a real case this shop has (test/shopifyOrders.test.js pins
 *  "1524-9" as a name, not a suffix), and splitting it would ask Shopify for order 1524 and write
 *  another customer's channel onto this one. The sidecar's `purchase.orderId` is the answer the
 *  extractor already computed; the split survives only as a last resort for a folder written before
 *  that field existed. */
function purchaseNumber(sidecar, folderName) {
  const fromSidecar = sidecar?.purchase?.orderId ?? sidecar?.order;
  if (typeof fromSidecar === 'string' && fromSidecar.trim()) return fromSidecar.trim();
  return String(folderName).split('-')[0];
}

const roots = [config.paths?.inbox, config.paths?.outbox].filter(Boolean);
const seen = new Map(); // orderId -> [dirs], because a book exists in both inbox and outbox
for (const root of roots) {
  for (const o of orderDirs(root)) {
    if (!seen.has(o.orderId)) seen.set(o.orderId, []);
    seen.get(o.orderId).push(o.dir);
  }
}

if (!seen.size) {
  console.log('No order folders with a sidecar found. Nothing to do.');
  process.exit(0);
}

const client = createAdminClient(config.shopify);
const cache = new Map(); // purchase number -> attribution, so siblings cost one query between them

let patched = 0;
let already = 0;
let unresolved = 0;
let unreadable = 0;
let failed = 0;

for (const [orderId, dirs] of [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }))) {
  for (const dir of dirs) {
    const path = join(dir, ORDER_INFO);
    let sidecar;
    try {
      sidecar = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      console.log(`  ${orderId.padEnd(10)} sidecar unreadable — skipped (${err.message})`);
      unreadable++;
      continue;
    }
    // `JSON.parse("null")` succeeds. Assigning onto that below would throw outside the try and take
    // the whole run down on one odd file, half-way through a backlog.
    if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
      console.log(`  ${orderId.padEnd(10)} sidecar is not an object — skipped`);
      unreadable++;
      continue;
    }
    if (sidecar.attribution) {
      already++;
      continue;
    }

    const number = purchaseNumber(sidecar, orderId);
    if (!cache.has(number)) {
      try {
        const node = await client.fetchOrderByName(number);
        cache.set(number, node ? attributionFrom(node) : null);
      } catch (err) {
        // A throttled or failed lookup is NOT "this order does not exist". Counting them together
        // makes a rate-limited run read as a shop missing half its orders, and the operator would
        // go looking for the wrong problem.
        console.log(`  ${orderId.padEnd(10)} Shopify lookup failed — skipped (${err.message})`);
        cache.set(number, { failed: true });
      }
    }
    const attribution = cache.get(number);
    if (attribution?.failed) {
      failed++;
      continue;
    }
    if (!attribution) {
      console.log(`  ${orderId.padEnd(10)} not found in Shopify — skipped`);
      unresolved++;
      continue;
    }

    const value = { ...attribution, channel: channelOf(attribution) };
    console.log(`  ${orderId.padEnd(10)} ${value.channel}${value.campaign ? ' · ' + value.campaign : ''}${write ? '' : '   (dry run)'}`);
    if (write) {
      // One key. The rest of this file is the customer's dedication and their email address —
      // which is also why the write goes through a temp file and a rename. This is the one tool
      // that rewrites files it did not create, and a plain in-place write interrupted by a crash or
      // a full disk leaves a truncated sidecar. `readOrderInfo` treats an unparseable sidecar as
      // "no answer", so the loss would be silent: the dedication reverts to a guess from the photo
      // filenames and the email needed to reach the customer is simply gone.
      sidecar.attribution = value;
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
      renameSync(tmp, path);
    }
    patched++;
  }
}

console.log(
  `\n${write ? 'Patched' : 'Would patch'} ${patched} folder(s). ` +
    `${already} already had it, ${unresolved} not found in Shopify, ${failed} lookup(s) failed, ${unreadable} unreadable.` +
    (write ? '' : '\nRe-run with --write to apply.'),
);
