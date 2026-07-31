// Customer photos do not get to live here forever.
//
// `retentionDays` has been in config.json since the first commit, and manifest.js has always said
// "the original may be purged after retentionDays". Nothing ever purged anything. Every child's
// face this tool has processed was still on the disk.
//
// What gets deleted is the *photograph* — `<base>.jpg`, the copy the tool echoed into the order
// folder. The line art stays: it is a drawing, and the operator may want to reprint from it.
//
// THE CLOCK NOW STARTS AT DISPATCH, NOT AT PRINT (R18, U11). Under the old lifecycle `sent` meant
// "handed to Jirka" and the only proof a book was finished was `printed.json`, so that marker was
// the gate and the commentary here said so. The lifecycle was re-cut (U9): a book is printed, and
// THEN the operator posts it to the customer and writes `sent.json`. Dispatch is the moment the
// studio's copy of a photograph stops being needed, so it is the moment the window starts.
//
// An order is only ever touched when its book is finished and gone:
//   - the operator has confirmed it was POSTED TO THE CUSTOMER (a `sent.json` marker): a book that
//     was merely printed is still on somebody's desk and is never purged,
//   - the PDF exists,
//   - the PDF is newer than state.json, so the book on disk is the one the decisions describe and
//     not one left stale by a verdict changed afterwards,
//   - and it was dispatched at least `retentionDays` ago, measured from that marker's MTIME.
//
// The mtime, not the `at` field inside the JSON: the U10 migration backfilled a dispatch marker for
// every already-printed order and set its mtime to the printed marker's, precisely so those orders
// keep the eligibility date they already had (R17). A marker backfilled that way is honoured here —
// its date is the truth about when the book left — but it is COUNTED SEPARATELY in the report, see
// `eligibility` below.
//
// TWO GUARDS THAT ARE NOT ABOUT AGE AT ALL:
//
//   - `cap`. Purge has never run on the hosted box, and the backfill gave essentially every order
//     ever printed a dispatch date in the distant past. The first confirmed run would therefore
//     offer to delete almost the entire outbox in one go. A single run deletes at most `cap` orders
//     and leaves the rest for the next one, so the first purge is a batch the operator can read.
//   - `stalled`. Eligibility now depends on an operator action that may never happen: an order
//     printed and then cancelled, refunded or simply forgotten never gets a dispatch marker and so
//     keeps its photographs forever. Those are LISTED, with their age, and never auto-deleted —
//     the point is that somebody decides, not that the disk quietly fills up.
//
// Read the caveat in `purgeWarning` before believing this makes the disk safe.

import { existsSync, readdirSync, readFileSync, statSync, rmSync, utimesSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readManifest, writeManifest, manifestPath } from './manifest.js';
import { outputPaths } from './organize.js';
import { reportPath } from './autopilotReport.js';
import { statePath } from './autopilotState.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many orders one confirmed purge may delete. Anything past it is reported as deferred and
 *  goes on the next run. Chosen small enough that an operator can actually read the list he is
 *  confirming — the number that matters is "reviewable", not "efficient". */
export const PURGE_BATCH_CAP = 25;

/** How many retention windows an order may sit printed-but-never-dispatched before the report calls
 *  it stalled. A multiple rather than its own day count, so raising `retentionDays` moves both
 *  clocks together and the backstop can never fire before the ordinary window would have. */
export const STALLED_WINDOW_MULTIPLE = 3;

/** The photographs are also inside the printed book. Say so, rather than let anyone believe the
 *  faces are gone from this machine. */
export const purgeWarning =
  'The photographs are also inside each "<order> Final.pdf", and in whatever folder you archived ' +
  'the finished books to. This only clears the working outbox.';

const pdfPathFor = (orderDir, orderId) => join(orderDir, `${orderId} Final.pdf`);
// The two lifecycle markers studio.js writes (kept as local literals, like pdfPathFor, so retention
// doesn't drag in studio.js's whole review/generator import chain). `delivered.json` — the retired
// marker — is deliberately absent: it meant "handed to Jirka", a state that now sits BEFORE
// printing, and reading it here would make a live customer's photographs purge-eligible (KTD6).
const printedMarkerPath = (orderDir) => join(orderDir, 'printed.json');
const sentMarkerPath = (orderDir) => join(orderDir, 'sent.json');

/** Was this dispatch marker written by the U10 migration rather than by an operator confirming a
 *  post? Only a label — a backfilled marker is honoured exactly like any other, because its date is
 *  the real date the book left. An unreadable marker counts as backfilled for the same reason
 *  studio.js reads one that way: "a file I cannot understand" is not evidence anybody confirmed
 *  anything, and the operator should see it in the historical column, not the fresh one. */
function isBackfilled(markerPath) {
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return true;
    return parsed.backfilled === true;
  } catch {
    return true;
  }
}

/** Every order in the outbox, with what a purge would do to it and why. Reads only. */
export function inspectOutbox({ outboxRoot, days, now = Date.now(), stalledMultiple = STALLED_WINDOW_MULTIPLE }) {
  if (!Number.isInteger(days) || days <= 0) throw new TypeError('days must be a positive integer');
  if (!Number.isInteger(stalledMultiple) || stalledMultiple <= 0) throw new TypeError('stalledMultiple must be a positive integer');
  if (!existsSync(outboxRoot)) return [];

  const stalledAfter = days * stalledMultiple;
  const orders = [];
  for (const entry of readdirSync(outboxRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const orderId = entry.name;
    const orderDir = join(outboxRoot, orderId);
    const state = manifestPath(orderDir);
    if (!existsSync(state)) continue; // not an order folder

    const pdfPath = pdfPathFor(orderDir, orderId);
    const printedPath = printedMarkerPath(orderDir);
    const sentPath = sentMarkerPath(orderDir);
    const manifest = readManifest(orderDir);
    const photos = Object.keys(manifest.photos ?? {})
      .map((base) => outputPaths(`${base}.jpg`, orderDir).original)
      .filter((p) => existsSync(p))
      .map((path) => ({ path, bytes: statSync(path).size }));

    const order = {
      orderId,
      orderDir,
      pdfPath,
      photos,
      bytes: photos.reduce((n, p) => n + p.bytes, 0),
      skip: null,
      ageDays: null,
      // Where the eligibility came from, for the report's two columns. Null until it is known.
      backfilled: null,
      // Printed-but-never-dispatched, in days, once it is past `stalledAfter`. Null otherwise.
      stalledDays: null,
    };

    // The DISPATCH marker is the gate (R18). A printed book still on the desk keeps its photographs:
    // it may yet need reprinting, and the customer has not had it.
    if (!existsSync(sentPath)) {
      order.skip = 'not dispatched to the customer yet';
      // The backstop. Nothing here deletes; it makes an order that will never become eligible on
      // its own visible, so it is resolved deliberately instead of accumulating in silence.
      if (existsSync(printedPath)) {
        const printedAgeDays = Math.floor((now - statSync(printedPath).mtimeMs) / DAY_MS);
        if (printedAgeDays >= stalledAfter) {
          order.stalledDays = printedAgeDays;
          order.skip = `printed ${printedAgeDays} days ago and never dispatched — decide what happened to it`;
        }
      }
    } else if (!existsSync(pdfPath)) order.skip = 'the book is not on disk';
    else if (statSync(pdfPath).mtimeMs < statSync(state).mtimeMs) order.skip = 'a decision changed after the book was built';
    else {
      order.backfilled = isBackfilled(sentPath);
      order.ageDays = Math.floor((now - statSync(sentPath).mtimeMs) / DAY_MS);
      if (order.ageDays < days) order.skip = `dispatched ${order.ageDays} day${order.ageDays === 1 ? '' : 's'} ago, keeping for ${days}`;
      else if (!photos.length) order.skip = 'the photographs are already gone';
    }

    orders.push(order);
  }
  return orders.sort((a, b) => a.orderId.localeCompare(b.orderId, 'en', { numeric: true }));
}

/** Delete the photographs of every dispatched order older than `days`.
 *
 *  `dryRun` is the default on purpose: this is the one operation in the tool that destroys
 *  something no regeneration can bring back.
 *
 *  `cap` bounds ONE run (PURGE_BATCH_CAP; pass null for no cap). It is applied on the dry run too,
 *  so what the operator reads is exactly what a confirmation would do — a report listing forty
 *  orders and a run deleting twenty-five would be a worse lie than no report at all. */
export function purgeOriginals({ outboxRoot, days, now = Date.now(), dryRun = true, cap = PURGE_BATCH_CAP, stalledMultiple = STALLED_WINDOW_MULTIPLE }) {
  if (cap != null && (!Number.isInteger(cap) || cap <= 0)) throw new TypeError('cap must be a positive integer or null');
  const inspected = inspectOutbox({ outboxRoot, days, now, stalledMultiple });
  const eligible = inspected.filter((o) => !o.skip);
  const limit = cap == null ? eligible.length : cap;
  const purgeable = eligible.slice(0, limit);
  const deferred = eligible.slice(limit);
  const stalled = inspected.filter((o) => o.stalledDays != null);

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
    cap: cap ?? null,
    orders: purgeable,
    // Eligible, but past the cap: nothing happens to these THIS run. Named rather than folded into
    // `skipped`, because "we ran out of batch" is not the same answer as "this order is not ready".
    deferred,
    skipped: inspected.filter((o) => o.skip),
    // Printed and never dispatched, past `days × stalledMultiple`. Reported, never deleted.
    stalled,
    photos: purgeable.reduce((n, o) => n + o.photos.length, 0),
    bytes: purgeable.reduce((n, o) => n + o.bytes, 0),
    // Where eligibility came from, counted over the WHOLE eligible set and not just this batch.
    // The first run on the hosted box will be almost entirely `backfilled` — orders printed under
    // the old lifecycle whose dispatch date the migration derived from their printed marker (R17).
    // Saying so on the report is what stops a large first batch reading as a bug.
    eligibility: {
      total: eligible.length,
      backfilled: eligible.filter((o) => o.backfilled === true).length,
      dispatched: eligible.filter((o) => o.backfilled === false).length,
    },
  };
}

// ---- overnight autopilot: night report + state ------------------------------
//
// The night report and the handled-set state carry order numbers and timestamps (customer-adjacent
// data), so they don't pile up indefinitely — they age out on the same `retentionDays` clock as the
// photographs. Both files are rewritten on every autopilot run, so a file only crosses the age line
// once the autopilot has been DORMANT that long — which is exactly when the data should be cleared.

/** What an autopilot-data purge would touch: the report + state files with their age and whether they
 *  are past `days`. Reads only. `dataDir` absent/missing (autopilot never ran) → nothing to do. */
export function inspectAutopilotData({ dataDir, days, now = Date.now() }) {
  if (!Number.isInteger(days) || days <= 0) throw new TypeError('days must be a positive integer');
  if (!dataDir || !existsSync(dataDir)) return [];
  const out = [];
  for (const path of [reportPath(dataDir), statePath(dataDir)]) {
    if (!existsSync(path)) continue;
    const ageDays = Math.floor((now - statSync(path).mtimeMs) / DAY_MS);
    out.push({ name: basename(path), path, ageDays, stale: ageDays >= days });
  }
  return out;
}

/** Delete the autopilot report/state once they are older than `days`. `dryRun` defaults true, like
 *  the photo purge — though unlike a photograph these regenerate on the next run. */
export function purgeAutopilotData({ dataDir, days, now = Date.now(), dryRun = true }) {
  const files = inspectAutopilotData({ dataDir, days, now });
  const removed = files.filter((f) => f.stale);
  if (!dryRun) for (const f of removed) rmSync(f.path, { force: true });
  return { dryRun, days, removed, kept: files.filter((f) => !f.stale) };
}
