// Backfill the dispatch marker onto the orders that were already through the OLD lifecycle (U10,
// KTD7, R17).
//
// The re-cut (U9) moved `sent` from "handed to Jirka" to "posted to the customer" and gave it a new
// file. Every order already carrying `printed.json` was, under the old model, finished — and under
// the old model its photographs were purge-eligible `retentionDays` after that print. Without a
// dispatch marker those orders can never reach the new terminal state, so their photographs become
// permanently un-purgeable: the exact opposite of what the retention work is for, on a disk that
// holds photographs of customers' children.
//
// THE CLOCK IS THE WHOLE POINT, AND IT IS NOT THE `at` FIELD.
//
// `retention.js` measures an order's age from the marker FILE'S MTIME — `statSync(marker).mtimeMs`
// — never from any timestamp inside the JSON. A marker written today has an mtime of today, so an
// order printed a hundred days ago would silently restart its retention window at day zero. A test
// asserting on the JSON's `at` would pass while the purge gate had quietly regressed by months. So
// the backfilled file's mtime is set to the PRINTED marker's mtime with `utimesSync` — the same
// idiom `retention.js` already uses to put state.json's clock back after a purge — and the test
// that guards this asserts on the MTIME.
//
// What it will and will not touch:
//
//   printed.json present, no sent.json  → write sent.json, flagged backfilled, at printed's mtime
//   sent.json already present           → nothing, including its mtime. Re-running changes nothing.
//   delivered.json only                 → NOTHING. That marker meant "handed to Jirka, not yet
//                                         printed"; the order returns to awaiting-print, which is
//                                         what it actually is. This is the dangerous row and the
//                                         reason the new marker exists at all (KTD6).
//   neither                             → nothing.
//   printed.json unreadable             → reported and skipped, never guessed at.
//
// Two invariants hold everywhere below: the full report is computed BEFORE anything is written, and
// no marker is ever written that was not derived from a marker this module first read.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { printedMarkerPath, sentMarkerPath } from '../studio.js';

/** A migration-seam failure, phrased for the operator. Carries `seam` like the other drivers, so a
 *  caller can say where it broke without matching on the message. */
export class SentMarkerMigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SentMarkerMigrationError';
    this.seam = 'migration';
  }
}

/** Why an order was left alone. Reported verbatim so the operator reading the dry run can tell a
 *  deliberate skip from a problem. */
export const SKIP_REASONS = Object.freeze({
  ALREADY_SENT: 'already carries a dispatch marker — left untouched',
  NOT_PRINTED: 'no printed marker — the order is still awaiting print',
  UNREADABLE: 'the printed marker could not be read — skipped rather than guessed at',
});

/** One order folder's decision, read-only. `null` when the entry is not an order folder at all. */
function decide(outboxRoot, orderId) {
  const orderDir = join(outboxRoot, orderId);
  const printedPath = printedMarkerPath(orderDir);
  const sentPath = sentMarkerPath(orderDir);

  // Checked FIRST, ahead of every other question: an existing dispatch marker is never overwritten,
  // never re-dated, and never even opened. Idempotence starts here.
  if (existsSync(sentPath)) return { orderId, orderDir, action: 'skip', reason: SKIP_REASONS.ALREADY_SENT };
  if (!existsSync(printedPath)) return { orderId, orderDir, action: 'skip', reason: SKIP_REASONS.NOT_PRINTED };

  let printed;
  let printedStat;
  try {
    printedStat = statSync(printedPath);
    printed = JSON.parse(readFileSync(printedPath, 'utf8'));
  } catch {
    return { orderId, orderDir, action: 'skip', reason: SKIP_REASONS.UNREADABLE };
  }
  if (!printed || typeof printed !== 'object' || Array.isArray(printed)) {
    return { orderId, orderDir, action: 'skip', reason: SKIP_REASONS.UNREADABLE };
  }

  // The marker's own mtime is the clock retention reads, so it is the clock carried across. `at` is
  // taken from the printed marker when it has one and falls back to that same mtime — it is the
  // human-readable copy of a date the file already carries, not a second source of truth.
  const at = typeof printed.at === 'string' && printed.at ? printed.at : new Date(printedStat.mtimeMs).toISOString();
  return {
    orderId,
    orderDir,
    action: 'backfill',
    reason: 'printed before the lifecycle was re-cut — dated from its printed marker (R17)',
    at,
    // What the file's mtime will be set to, and what a test can assert the result against.
    mtimeMs: printedStat.mtimeMs,
    printedBy: typeof printed.by === 'string' && printed.by ? printed.by : 'operator',
  };
}

/** What the migration WOULD do, in full, touching nothing. This is the report the operator reads
 *  before confirming — and the same function `backfillSentMarkers` runs before it writes, so the
 *  thing that was reported is the thing that happens. */
export function planSentMarkerBackfill({ outboxRoot }) {
  if (!outboxRoot || typeof outboxRoot !== 'string') throw new SentMarkerMigrationError('An outbox folder is required.');
  if (!existsSync(outboxRoot)) throw new SentMarkerMigrationError(`The outbox folder does not exist: ${outboxRoot}`);

  const planned = [];
  const skipped = [];
  for (const entry of readdirSync(outboxRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const decision = decide(outboxRoot, entry.name);
    (decision.action === 'backfill' ? planned : skipped).push(decision);
  }
  const byId = (a, b) => a.orderId.localeCompare(b.orderId, 'en', { numeric: true });
  return { outboxRoot, planned: planned.sort(byId), skipped: skipped.sort(byId) };
}

/** Run the backfill. `apply` defaults to FALSE: like the purge, the reporting posture is the default
 *  one, because this writes into live customer order folders on a mounted disk.
 *
 *  Returns the same shape either way — `written` is empty on a dry run — so the operator compares
 *  what was reported against what happened without reading two different objects. */
export function backfillSentMarkers({ outboxRoot, apply = false, now = () => new Date() }) {
  const plan = planSentMarkerBackfill({ outboxRoot });
  const written = [];
  if (apply) {
    for (const item of plan.planned) {
      const sentPath = sentMarkerPath(item.orderDir);
      // Re-checked at the moment of writing, not only when the plan was built: between the report
      // and the confirmation the operator may have marked the order sent by hand from the board.
      // An existing marker is never overwritten (rule 5) — including its mtime.
      if (existsSync(sentPath)) {
        plan.skipped.push({ orderId: item.orderId, orderDir: item.orderDir, action: 'skip', reason: SKIP_REASONS.ALREADY_SENT });
        continue;
      }
      writeFileSync(
        sentPath,
        JSON.stringify(
          {
            at: item.at,
            by: item.printedBy,
            // Load-bearing, not an audit note: deriveOrderStatus reads this and refuses to treat the
            // order as dispatched, so a book that was printed but possibly never posted stays in the
            // operator's worklist. Retention still measures its window from this marker's date.
            backfilled: true,
            backfilledFrom: 'printed.json',
            backfilledAt: now().toISOString(),
          },
          null,
          2,
        ),
      );
      // THE CLOCK. Without this the file's mtime is now, and retention — which reads the mtime and
      // not the `at` above — would restart this order's window at day zero (R17).
      const printedStat = statSync(printedMarkerPath(item.orderDir));
      utimesSync(sentPath, printedStat.atime, printedStat.mtime);
      written.push(item.orderId);
    }
  }
  return {
    outboxRoot: plan.outboxRoot,
    applied: apply === true,
    planned: plan.planned,
    skipped: plan.skipped,
    written,
    counts: { planned: plan.planned.length, skipped: plan.skipped.length, written: written.length },
  };
}
