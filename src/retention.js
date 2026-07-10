// Customer photos do not get to live here forever.
//
// `retentionDays` has been in config.json since the first commit, and manifest.js has always said
// "the original may be purged after retentionDays". Nothing ever purged anything. Every child's
// face this tool has processed was still on the disk.
//
// What gets deleted is the *photograph* — `<base>.jpg`, the copy the tool echoed into the order
// folder. The line art stays: it is a drawing, and the operator may want to reprint from it.
//
// An order is only ever touched when its book is finished and settled:
//   - the PDF exists,
//   - the PDF is newer than state.json, so it was printed from the decisions on disk and not
//     left stale by a verdict changed afterwards,
//   - and it was printed at least `retentionDays` ago.
//
// Read the caveat in `purgeWarning` before believing this makes the disk safe.

import { existsSync, readdirSync, statSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { readManifest, writeManifest, manifestPath } from './manifest.js';
import { outputPaths } from './organize.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The photographs are also inside the printed book. Say so, rather than let anyone believe the
 *  faces are gone from this machine. */
export const purgeWarning =
  'The photographs are also inside each "<order> Final.pdf", and in whatever folder you archived ' +
  'the finished books to. This only clears the working outbox.';

const pdfPathFor = (orderDir, orderId) => join(orderDir, `${orderId} Final.pdf`);

/** Every order in the outbox, with what a purge would do to it and why. Reads only. */
export function inspectOutbox({ outboxRoot, days, now = Date.now() }) {
  if (!Number.isInteger(days) || days <= 0) throw new TypeError('days must be a positive integer');
  if (!existsSync(outboxRoot)) return [];

  const orders = [];
  for (const entry of readdirSync(outboxRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const orderId = entry.name;
    const orderDir = join(outboxRoot, orderId);
    const state = manifestPath(orderDir);
    if (!existsSync(state)) continue; // not an order folder

    const pdfPath = pdfPathFor(orderDir, orderId);
    const manifest = readManifest(orderDir);
    const photos = Object.keys(manifest.photos ?? {})
      .map((base) => outputPaths(`${base}.jpg`, orderDir).original)
      .filter((p) => existsSync(p))
      .map((path) => ({ path, bytes: statSync(path).size }));

    const order = { orderId, orderDir, pdfPath, photos, bytes: photos.reduce((n, p) => n + p.bytes, 0), skip: null, ageDays: null };

    if (!existsSync(pdfPath)) order.skip = 'the book has not been printed yet';
    else if (statSync(pdfPath).mtimeMs < statSync(state).mtimeMs) order.skip = 'a decision changed after the book was printed';
    else {
      order.ageDays = Math.floor((now - statSync(pdfPath).mtimeMs) / DAY_MS);
      if (order.ageDays < days) order.skip = `printed ${order.ageDays} day${order.ageDays === 1 ? '' : 's'} ago, keeping for ${days}`;
      else if (!photos.length) order.skip = 'the photographs are already gone';
    }

    orders.push(order);
  }
  return orders.sort((a, b) => a.orderId.localeCompare(b.orderId, 'en', { numeric: true }));
}

/** Delete the photographs of every settled order older than `days`.
 *
 *  `dryRun` is the default on purpose: this is the one operation in the tool that destroys
 *  something no regeneration can bring back. */
export function purgeOriginals({ outboxRoot, days, now = Date.now(), dryRun = true }) {
  const inspected = inspectOutbox({ outboxRoot, days, now });
  const purgeable = inspected.filter((o) => !o.skip);

  if (!dryRun) {
    for (const order of purgeable) {
      for (const photo of order.photos) rmSync(photo.path, { force: true });

      // So the grid can say "photo purged" instead of "photo missing", and so a second run of
      // this can tell the difference between done and never-had-one.
      const state = manifestPath(order.orderDir);
      const was = statSync(state);
      const manifest = readManifest(order.orderDir);
      manifest.photosPurgedAt = new Date(now).toISOString();
      writeManifest(order.orderDir, manifest);

      // state.json's mtime is the order's "last decided" clock: the orchestrator reprints any book
      // older than it. Deleting a photograph is not a decision, and a reprint would fail anyway
      // now that the photograph is gone. Put the clock back where the operator left it.
      utimesSync(state, was.atime, was.mtime);
    }
  }

  return {
    dryRun,
    days,
    orders: purgeable,
    skipped: inspected.filter((o) => o.skip),
    photos: purgeable.reduce((n, o) => n + o.photos.length, 0),
    bytes: purgeable.reduce((n, o) => n + o.bytes, 0),
  };
}
