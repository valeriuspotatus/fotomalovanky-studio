import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ingestOrders } from './ingest.js';
import { readOrderInfo, orderInfoPath } from './orderInfo.js';

// The Chrome extension drops a new order folder into the inbox; nothing else triggers generation for it
// (the Shopify autopilot only runs orders IT fetched). This decides which inbox orders are ready to
// generate RIGHT NOW so the server can start them without a manual "Spustit". It is a pure read — it
// never starts anything — so it is testable without a browser, a GPU, or a running server.

/** Order ids in `inbox` that should auto-generate now. An order qualifies when it is:
 *   - unprocessed — no state.json in its outbox dir (a processed order, even a held one, has one);
 *   - complete — objednavka.json has landed (so the customer's dedication is present) AND, when that
 *     file states an expected photo count, that many photos are on disk (the download finished);
 *   - settled — the newest file (photo or objednavka.json) is at least `settleMs` old, so we never
 *     fire mid-download.
 *  Throws (via ingestOrders) only when the inbox folder is missing; the caller treats that as "nothing
 *  to do". Requiring objednavka.json means a legacy folder without one falls back to manual Go — a safe
 *  failure (manual), never a book generated without its dedication. */
export function selectAutoRunOrders({ inbox, outbox, now = Date.now(), settleMs = 8_000 } = {}) {
  const ready = [];
  for (const o of ingestOrders(inbox)) {
    if (existsSync(join(outbox, o.orderId, 'state.json'))) continue; // already processed
    const info = readOrderInfo(o.dir);
    if (!info) continue; // objednavka.json not written yet — wait so the dedication isn't missed
    if (info.expectedPhotos && o.photos.length < info.expectedPhotos) continue; // still downloading
    const files = [...o.photos, orderInfoPath(o.dir)].filter((f) => existsSync(f));
    let newest = 0;
    for (const f of files) {
      try { newest = Math.max(newest, statSync(f).mtimeMs); } catch { /* vanished mid-scan */ }
    }
    if (newest === 0 || now - newest < settleMs) continue; // still being written
    ready.push(o.orderId);
  }
  return ready;
}
