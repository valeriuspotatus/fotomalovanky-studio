import { readdirSync, existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { isPhoto } from './organize.js';

export class IngestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IngestError';
    this.seam = 'ingest';
  }
}

/** The Chrome extension names each photo "<order>_img<NNNN>_-_<label>.jpeg".
 *  "1523_img0002_-_hofbauerovi_18.7.2026.jpeg" -> "1523".
 *
 *  A book from a multi-book purchase carries a position suffix ("1234-2_img0001_-_…" -> "1234-2").
 *  Without it in this pattern the match fails, every photo returns null, and `orderIdFor` falls
 *  through to the folder name — the right answer by the wrong route, and silently the WRONG answer
 *  the moment a folder holds photos named with the bare purchase number: filename consensus would
 *  then derive "1234" and re-merge the two books that were just separated. */
export function orderIdFromPhoto(filename) {
  const m = /^(\d+(?:-\d+)?)_img\d+/i.exec(basename(filename));
  return m ? m[1] : null;
}

function photosIn(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && isPhoto(e.name))
    .map((e) => join(dir, e.name))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

/** The photo names win over the folder name. The extension writes the order number into
 *  every filename; folder names get hand-edited (one real sample folder is named "…1522…"
 *  yet holds eight 1523_img* photos). Fall back to the folder only when the photos don't
 *  unanimously agree on an id — which also covers photos not named by the extension. */
function orderIdFor(dir, photos) {
  const ids = photos.map(orderIdFromPhoto);
  const agreed = new Set(ids);
  return ids.every(Boolean) && agreed.size === 1 ? ids[0] : basename(dir);
}

function toOrder(dir, photos) {
  return { orderId: orderIdFor(dir, photos), dirName: basename(dir), dir, photos };
}

/** Map the extension's download folder to an order -> photos model.
 *  Each subfolder holding photos is one order; non-image files and photo-less subfolders
 *  are ignored. The operator may also point straight at a single order folder, so loose
 *  photos at the root count as one order too. */
export function ingestOrders(inboxRoot) {
  const root = resolve(inboxRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new IngestError(
      `Input folder not found: ${root}. Point the tool at the folder the Chrome extension downloads orders into.`,
    );
  }

  const orders = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(root, entry.name);
    const photos = photosIn(dir);
    if (photos.length > 0) orders.push(toOrder(dir, photos));
  }

  const loose = photosIn(root);
  if (loose.length > 0) orders.push(toOrder(root, loose));

  return orders.sort((a, b) => a.orderId.localeCompare(b.orderId, 'en', { numeric: true }));
}
