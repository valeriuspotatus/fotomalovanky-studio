import { existsSync, writeFileSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewState } from './review.js';
import { pdfPathFor } from './orchestrator.js';
import { intakeSummary } from './intake.js';
import { readReport } from './autopilotReport.js';

// The live order board behind the dashboard's Objednávky and Potřebuje vás tabs (KTD5/KTD6).
//
// Every order-level status is DERIVED on read, never stored: the review grid already owns the
// per-photo truth in state.json, and a second mutable "order status" field beside it would be one
// more thing to keep in sync. The aggregation is a pure function over the review state plus a few
// facts that state cannot see on its own — is the run generating this order right now, is its PDF
// built, has Jirka printed it, has it been posted to the customer — so a test drives it with fakes
// and never touches disk.
//
// THE LIFECYCLE WAS RE-CUT (R14, R15, KTD6). It used to read ready → sent (handed to Jirka) →
// printed. It now reads ready-to-print → printed (Jirka prints it) → sent (the operator posts the
// book to the CUSTOMER). `sent` therefore means something different from what it meant when the
// orders on the live disk were written, which is why it has a NEW marker file rather than the old
// one re-interpreted.
//
// `delivered.json` — the retired marker — is left exactly where it is on every order folder that
// carries it, and is NEVER READ AGAIN. It recorded "handed to Jirka", a state that now sits BEFORE
// printing; reading it here would derive a book still waiting for the printer as already posted to
// the customer, drop it off the operator's board, and (once retention moves onto this marker) make
// a live customer's photographs purge-eligible. Deleting it would be equally wrong: it is the only
// record those handoffs ever happened. So: left alone, never consulted.

/** The dispatch marker: the finished book was posted to the CUSTOMER (R14). A DISTINCT filename
 *  from the retired `delivered.json` — see the note above; the two mean different things and must
 *  never share a path. Its presence is the source of truth for 'sent'. */
export const sentMarkerPath = (orderDir) => join(orderDir, 'sent.json');

/** The operator confirms a printed book has gone into the post: write the terminal dispatch marker
 *  so the order derives to 'sent' and drops off the active board. This is a MANUAL acknowledgement
 *  and the ONLY way the marker is ever written — nothing in this tool posts anything to anyone; it
 *  only records that the operator already did. Idempotent. */
export function markSent(orderDir, info = {}) {
  writeFileSync(
    sentMarkerPath(orderDir),
    JSON.stringify({ at: new Date().toISOString(), by: 'operator', ...info }, null, 2),
  );
  return ORDER_BOARD_STATES.SENT;
}

/** Undo a dispatch mark set by mistake — removes the marker so the order returns to 'printed'.
 *  Safe when no marker is present. */
export function unmarkSent(orderDir) {
  rmSync(sentMarkerPath(orderDir), { force: true });
  return true;
}

/** What an order's dispatch marker says, or null when there is none.
 *
 *  `backfilled` is the load-bearing bit (KTD7, U10). A backfilled marker was derived from
 *  `printed.json` by the migration purely to preserve the order's purge-eligibility date (R17) —
 *  nobody confirmed the book was ever posted. So it is NOT a dispatch as far as the board is
 *  concerned; see deriveOrderStatus.
 *
 *  An unreadable marker is reported as `backfilled: true` for the same reason: the safe reading of
 *  "there is a file here I cannot understand" is "this dispatch is unconfirmed", which keeps the
 *  order in front of the operator instead of quietly retiring it. */
export function readSentMarker(orderDir) {
  const path = sentMarkerPath(orderDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { backfilled: true };
    return { backfilled: parsed.backfilled === true };
  } catch {
    return { backfilled: true }; // present but unreadable → unconfirmed, never terminal
  }
}

/** The 'printed' marker: Jirka confirms he actually printed the book (N3, R15). It now sits BEFORE
 *  dispatch — a printed book is not yet in the post — and it is what the migration dates the
 *  backfilled dispatch marker from (KTD7). Its presence is the source of truth for 'printed'. */
export const printedMarkerPath = (orderDir) => join(orderDir, 'printed.json');

/** Jirka marks a ready book printed. Idempotent. The marker's own mtime is the clock the U10
 *  migration copies onto a backfilled dispatch marker, so retention cannot restart at zero. */
export function markPrinted(orderDir, info = {}) {
  writeFileSync(
    printedMarkerPath(orderDir),
    JSON.stringify({ at: new Date().toISOString(), by: 'operator', ...info }, null, 2),
  );
  return ORDER_BOARD_STATES.PRINTED;
}

/** Undo a printed mark set by mistake — the order returns to 'ready-to-print'. Safe when no marker
 *  is present. */
export function unmarkPrinted(orderDir) {
  rmSync(printedMarkerPath(orderDir), { force: true });
  return true;
}

/** The order-level board statuses. Distinct from the per-photo STATES and from the photo-level
 *  `handoff` (manual repair) — this is where the whole order sits on its way to the customer. The
 *  client `STATUS` map in src/ui/static/dashboard.html must carry a label for each of these values. */
export const ORDER_BOARD_STATES = Object.freeze({
  QUEUED: 'queued',
  GENERATING: 'generating',
  HELD: 'held',
  PENDING_REVIEW: 'pending-review',
  APPROVED: 'approved', // every photo approved, but no Final.pdf on disk yet → CTA "Vytvořit PDF"
  READY_TO_PRINT: 'ready-to-print', // the book exists on disk → Jirka's queue, CTA "Označit vytištěno"
  PRINTED: 'printed', // Jirka printed it; awaiting the operator's post → CTA "Označit odeslané"
  SENT: 'sent', // posted to the CUSTOMER; terminal, and the only state a purge will ever touch
  FAILED: 'failed',
});

/** One order's board status from its review state plus the injected facts. Pure.
 *
 *  Order matters: dispatch to the customer is terminal and outranks printing (R14 — the reverse of
 *  the old machine, where 'sent' meant "handed to Jirka" and printing came after), an intake hold
 *  outranks generation (a held order never generates), and a live run on this order beats any
 *  half-finished photo state. */
export function deriveOrderStatus(order, { generating = false, pdfBuilt = false, sent = false, sentBackfilled = false, printed = false } = {}) {
  const s = order.summary ?? { total: 0, eligible: 0, held: 0, manual: 0, failed: 0, pending: 0, ready: false };
  // A stored intake hold only means "held" while nothing has generated past it. Generation is
  // skipped entirely for a held order, so a genuine hold has every photo still pending; once the
  // customer's fix lets the order generate and build, a lingering block (cleared at the source on
  // the next run, but guarded here too) must not keep a finished book under "needs you".
  const intakeHeld = order.intake?.verdict === 'hold' && order.intake?.override !== true && s.pending === s.total;

  // Dispatch is terminal and outranks printing — but ONLY a dispatch somebody actually performed.
  //
  // A backfilled marker (KTD7) was written by the U10 migration from an order's `printed.json`, to
  // keep the purge-eligibility date it already had (R17). It asserts a dispatch that may never have
  // happened: those books were printed under the old lifecycle, where nothing recorded posting them
  // to the customer. So the board reads a backfilled marker as "printed, dispatch unknown" and
  // keeps the order in the operator's worklist until he confirms it by hand.
  //
  // This is the ONE place where what retention counts and what the board shows deliberately part
  // company: retention (a later unit) measures its window from the marker's date, backfilled or
  // not, because that date is the truth about when the book left the studio's hands. The board
  // ignores the same marker, because "we think this was probably posted" is not something to tell
  // an operator who still has the parcel on his desk. Do not "simplify" these into one rule.
  if (sent && !sentBackfilled) return ORDER_BOARD_STATES.SENT;
  if (printed) return ORDER_BOARD_STATES.PRINTED; // Jirka printed it; it still has to be posted
  if (intakeHeld) return ORDER_BOARD_STATES.HELD; // surfaces under Potřebuje vás with its draft email
  if (generating) return ORDER_BOARD_STATES.GENERATING; // the run is on this order right now
  if (s.failed > 0) return ORDER_BOARD_STATES.FAILED;
  if (s.held > 0 || s.manual > 0) return ORDER_BOARD_STATES.PENDING_REVIEW; // a photo awaits the operator
  // Split the old "připraveno" collision (N1): a book already on disk is ready to PRINT; an order with
  // every photo approved but no PDF yet is APPROVED and needs "Vytvořit PDF". One state → one CTA, so
  // the home card and the board can never disagree about whether the PDF exists.
  if (pdfBuilt) return ORDER_BOARD_STATES.READY_TO_PRINT; // the finished book is on disk → Jirka prints it
  if (s.ready) return ORDER_BOARD_STATES.APPROVED; // all photos approved, PDF not built yet → build it
  // Anything left is unfinished with nothing flagged: an untouched order, or one a stopped run left
  // part-generated (some photos ok, the rest still to run). Both just need Go pressed to finish —
  // queued, not a review the operator would open to find nothing waiting.
  return ORDER_BOARD_STATES.QUEUED;
}

/** The short "why" line for a held order, from its stored intake block. Falls back rather than
 *  throwing on an override-only or malformed block. */
function heldReason(order) {
  const intake = order.intake;
  if (intake && Array.isArray(intake.findings)) {
    try {
      return intakeSummary(intake);
    } catch {
      /* fall through to the neutral reason */
    }
  }
  return 'problém se vstupními fotkami — čeká na vás';
}

/** One order's board entry — the shape the dashboard renders. Filesystem paths are deliberately
 *  left out: the read board addresses orders by id, and a held order's email is the only order
 *  content the browser needs. */
function boardEntry(order, status) {
  const s = order.summary ?? {};
  const held = status === ORDER_BOARD_STATES.HELD;
  // Pages the product should have, and how many photos are still missing (N8) — from the intake
  // count finding when one exists, else the incomplete-book flag. Null when the order is complete,
  // so the board denominator falls back to the photos on hand.
  const countFinding = order.intake?.findings?.find((f) => f.check === 'count');
  const expectedPages = countFinding?.expected ?? order.intake?.incompleteBook?.expected ?? null;
  const missingPhotos = countFinding?.missing ?? null;
  return {
    orderId: order.orderId,
    dirName: order.dirName ?? order.orderId,
    inInbox: Boolean(order.inInbox),
    status,
    dedication: order.dedication ?? '',
    photos: {
      total: s.total ?? 0,
      eligible: s.eligible ?? 0,
      held: s.held ?? 0,
      pending: s.pending ?? 0,
      failed: s.failed ?? 0,
      ready: Boolean(s.ready),
    },
    // Product page count + missing photos for the "Stránky" column (N8).
    expectedPages,
    missingPhotos,
    // Only a held order carries an email to send and a reason; everything else omits them.
    reason: held ? heldReason(order) : null,
    draftEmail: held ? order.draftEmail || '' : '',
    // Customer-communication state (N4): when the operator last emailed about this hold, or null.
    emailedAt: held ? order.emailedAt ?? null : null,
    // The persistent "operator shipped an under-count book" flag (N2), or null. Set at override
    // time and never cleared, so it warns on every board glance and in the send confirmation.
    incomplete: order.intake?.incompleteBook ?? null,
  };
}

/** Build the whole board from review-state orders plus injected fact-providers. Pure over its
 *  inputs — `pdfBuilt`/`sent`/`printed` are predicates, `runningOrderId` a plain id — so the whole
 *  status machine is testable without a filesystem or a running server. */
export function buildBoard(orders, { runningOrderId = null, pdfBuilt = () => false, sent = () => false, sentBackfilled = () => false, printed = () => false, createdAt = () => null, stale = () => false, firstLiveOrder = null } = {}) {
  // Hide old test orders: everything below the first real order number never reaches the board or
  // its counts. Non-numeric ids are always kept — the floor only judges what it can compare.
  const live =
    firstLiveOrder == null
      ? orders
      : orders.filter((order) => {
          const n = Number.parseInt(order.orderId, 10);
          return Number.isNaN(n) || n >= firstLiveOrder;
        });
  const board = live.map((order) => {
    const status = deriveOrderStatus(order, {
      generating: runningOrderId != null && order.orderId === runningOrderId,
      pdfBuilt: pdfBuilt(order),
      sent: sent(order),
      sentBackfilled: sentBackfilled(order),
      printed: printed(order),
    });
    const entry = boardEntry(order, status);
    entry.createdAt = createdAt(order); // ms since epoch, or null — drives the Stáří column (N8)
    // Stale, RE-SCOPED with the lifecycle (N10): only an order whose book has been PRINTED can be
    // stale, and it means the PDF was rebuilt after that print — so the physical book in Jirka's
    // hands, or already in the post, is not the book the decisions on disk now describe. Under the
    // old machine this hung off 'sent' because 'sent' was the moment a file left for the printer;
    // that moment is now the print itself. It stays true once the order is dispatched, where it is
    // the operator's cue that the customer may need a corrected copy.
    entry.stale = (status === ORDER_BOARD_STATES.PRINTED || status === ORDER_BOARD_STATES.SENT) && stale(order);
    return entry;
  });

  // Oldest-first: the operator works the queue in the order the customers sent it.
  board.sort((a, b) => a.orderId.localeCompare(b.orderId, 'en', { numeric: true }));

  const counts = { total: board.length };
  for (const state of Object.values(ORDER_BOARD_STATES)) counts[state] = 0;
  for (const entry of board) counts[entry.status] += 1;

  const needsYou = board.filter((entry) => entry.status === ORDER_BOARD_STATES.HELD);
  return { orders: board, counts, needsYou };
}

/** The compact overnight rollup the dashboard banner reads, distilled from the night report the
 *  autopilot wrote (src/autopilot.js → autopilotReport.js). Aggregate counts only — no order email,
 *  no token, nothing beyond the order numbers already on the board — so it is safe for the page.
 *  Returns null when there is no report (a manual-only day / fresh install), so the banner hides. */
export function overnightSummary(report) {
  if (!report || typeof report !== 'object') return null;
  const c = report.counts && typeof report.counts === 'object' ? report.counts : {};
  const ready = Number.isInteger(c.ready) ? c.ready : 0;
  const held = Number.isInteger(c.held) ? c.held : 0;
  const failed = Number.isInteger(c.failed) ? c.failed : 0;
  return {
    ranAt: typeof report.ranAt === 'string' ? report.ranAt : null,
    orders: { ready, held, failed },
    count: Number.isInteger(report.processed) ? report.processed : ready + held + failed,
    estSpend: typeof report.estSpend === 'number' ? report.estSpend : null,
  };
}

/** The live board over a real inbox/outbox: reads the review state and stats each order's PDF and
 *  its two lifecycle markers. `state` is injected so a test can drive the wiring with a fake review state.
 *  `dataDir` (config.shopify.dataDir) is where the overnight report lives; when set and a report is
 *  present, the board carries the morning rollup. `readReportFn` is injected for tests. */
export function studioBoard({ inboxRoot, outboxRoot, runningOrderId = null, only = null, memoryRoot, firstLiveOrder = null, dataDir = null, state = reviewState, readReportFn = readReport } = {}) {
  const orders = state({ inboxRoot, outboxRoot, only, memoryRoot });
  const board = buildBoard(orders, {
    runningOrderId,
    firstLiveOrder,
    pdfBuilt: (o) => existsSync(pdfPathFor(o.orderDir, o.orderId)),
    // `delivered.json` is deliberately absent from this list — see the note at the top of the file.
    sent: (o) => readSentMarker(o.orderDir) !== null,
    sentBackfilled: (o) => readSentMarker(o.orderDir)?.backfilled === true,
    printed: (o) => existsSync(printedMarkerPath(o.orderDir)),
    // Order age (N8): the folder's creation time, best proxy for when the order arrived. birthtime is
    // unreliable on some filesystems (reads 0) — fall back to mtime there.
    createdAt: (o) => {
      try {
        const st = statSync(o.orderDir);
        return st.birthtimeMs || st.mtimeMs || null;
      } catch {
        return null;
      }
    },
    // Printed-book staleness (N10, re-scoped): the book on disk is newer than the print of it.
    //
    // Measured against the printed marker's own MTIME rather than a PDF mtime stamped inside it —
    // which is how the retired delivery marker did it. Two reasons: the printed markers already on
    // the live disk carry no such stamp, so a stamped field would read false for every order that
    // exists today; and the marker file's mtime IS the moment the print was recorded, which is the
    // fact being compared against.
    stale: (o) => {
      const marker = printedMarkerPath(o.orderDir);
      const pdf = pdfPathFor(o.orderDir, o.orderId);
      if (!existsSync(marker) || !existsSync(pdf)) return false;
      try {
        return statSync(pdf).mtimeMs > statSync(marker).mtimeMs + 1000; // 1s epsilon
      } catch {
        return false;
      }
    },
  });
  const overnight = dataDir ? overnightSummary(readReportFn(dataDir)) : null;
  return { ...board, overnight };
}
