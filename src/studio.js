import { existsSync, writeFileSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { reviewState } from './review.js';
import { pdfPathFor } from './orchestrator.js';
import { intakeSummary } from './intake.js';
import { readReport } from './autopilotReport.js';

// The live order board behind the dashboard's Objednávky and Potřebuje vás tabs (KTD5/KTD6).
//
// Every order-level status is DERIVED on read, never stored: the review grid already owns the
// per-photo truth in state.json, and a second mutable "order status" field beside it would be one
// more thing to keep in sync. The aggregation is a pure function over the review state plus three
// facts that state cannot see on its own — is the run generating this order right now, is its PDF
// built, and has it been delivered to Jirka — so a test drives it with fakes and never touches disk.

/** The Jirka-delivery marker written into an order's outbox folder once the book is on its way to
 *  the printer (Phase 2). Its presence is the single source of truth for 'sent'. */
export const deliveredMarkerPath = (orderDir) => join(orderDir, 'delivered.json');

/** The operator confirms a finished book has gone to Jirka: write the terminal delivery marker so
 *  the order derives to 'sent' and drops off the active board. This is a MANUAL acknowledgement —
 *  nothing here contacts Jirka; it only records that the operator already did. Idempotent. Later,
 *  automated WhatsApp delivery (Phase 2) would write the same marker in the operator's place. */
export function markDelivered(orderDir, info = {}) {
  // Stamp the mtime of the exact PDF that went out (N10): if the book is rebuilt after this, the
  // board can tell the sent file is now stale and offer to re-send. mtime, not a hash — a rebuild
  // always rewrites the file, and hashing every sent PDF on each board poll would be wasteful.
  const pdf = pdfPathFor(orderDir, basename(orderDir));
  const sentPdfMtime = existsSync(pdf) ? statSync(pdf).mtimeMs : null;
  writeFileSync(
    deliveredMarkerPath(orderDir),
    JSON.stringify({ at: new Date().toISOString(), by: 'operator', ...info, sentPdfMtime }, null, 2),
  );
  return ORDER_BOARD_STATES.SENT;
}

/** Undo a delivery mark set by mistake — removes the marker so the order returns to the active
 *  board (usually back to 'ready-to-send'). Safe when no marker is present. */
export function unmarkDelivered(orderDir) {
  rmSync(deliveredMarkerPath(orderDir), { force: true });
  return true;
}

/** The 'printed' marker: the operator confirms Jirka actually printed the book (N3). This single
 *  manual bit closes the lifecycle past 'sent' — a WhatsApp message could be lost, so 'odesláno' is
 *  not proof of print — and it is what gates the photo purge: a customer's photos are only ever
 *  deleted once their book is confirmed printed (see retention.js). Its presence is the source of
 *  truth for 'printed'. */
export const printedMarkerPath = (orderDir) => join(orderDir, 'printed.json');

/** Operator marks a sent order printed once Jirka confirms. Terminal + idempotent; the timestamp is
 *  the clock the purge measures retention from. */
export function markPrinted(orderDir, info = {}) {
  writeFileSync(
    printedMarkerPath(orderDir),
    JSON.stringify({ at: new Date().toISOString(), by: 'operator', ...info }, null, 2),
  );
  return ORDER_BOARD_STATES.PRINTED;
}

/** Undo a printed mark set by mistake — the order returns to 'sent'. Safe when no marker is present. */
export function unmarkPrinted(orderDir) {
  rmSync(printedMarkerPath(orderDir), { force: true });
  return true;
}

/** The order-level board statuses. Distinct from the per-photo STATES and from the photo-level
 *  `handoff` (manual repair) — this is where the whole order sits on its way to Jirka. The client
 *  `STATUS` map in src/ui/static/dashboard.html must carry a label for each of these values. */
export const ORDER_BOARD_STATES = Object.freeze({
  QUEUED: 'queued',
  GENERATING: 'generating',
  HELD: 'held',
  PENDING_REVIEW: 'pending-review',
  APPROVED: 'approved', // every photo approved, but no Final.pdf on disk yet → CTA "Vytvořit PDF"
  READY_TO_SEND: 'ready-to-send', // the book exists on disk → CTA "Odeslat Jirkovi"
  SENT: 'sent', // delivered to Jirka, awaiting his print confirmation → CTA "Označit vytištěno"
  PRINTED: 'printed', // Jirka confirmed the print; terminal, and the only state a purge will touch
  FAILED: 'failed',
});

/** One order's board status from its review state plus the three injected facts. Pure.
 *
 *  Order matters: the delivery marker is terminal, an intake hold outranks generation (a held
 *  order never generates), and a live run on this order beats any half-finished photo state. */
export function deriveOrderStatus(order, { generating = false, pdfBuilt = false, delivered = false, printed = false } = {}) {
  const s = order.summary ?? { total: 0, eligible: 0, held: 0, manual: 0, failed: 0, pending: 0, ready: false };
  // A stored intake hold only means "held" while nothing has generated past it. Generation is
  // skipped entirely for a held order, so a genuine hold has every photo still pending; once the
  // customer's fix lets the order generate and build, a lingering block (cleared at the source on
  // the next run, but guarded here too) must not keep a finished book under "needs you".
  const intakeHeld = order.intake?.verdict === 'hold' && order.intake?.override !== true && s.pending === s.total;

  if (printed) return ORDER_BOARD_STATES.PRINTED; // terminal — outranks sent, the lifecycle is closed
  if (delivered) return ORDER_BOARD_STATES.SENT; // the marker is idempotent — a sent order stays sent
  if (intakeHeld) return ORDER_BOARD_STATES.HELD; // surfaces under Potřebuje vás with its draft email
  if (generating) return ORDER_BOARD_STATES.GENERATING; // the run is on this order right now
  if (s.failed > 0) return ORDER_BOARD_STATES.FAILED;
  if (s.held > 0 || s.manual > 0) return ORDER_BOARD_STATES.PENDING_REVIEW; // a photo awaits the operator
  // Split the old "připraveno" collision (N1): a book already on disk is ready to SEND; an order with
  // every photo approved but no PDF yet is APPROVED and needs "Vytvořit PDF". One state → one CTA, so
  // the home card and the board can never disagree about whether the PDF exists.
  if (pdfBuilt) return ORDER_BOARD_STATES.READY_TO_SEND; // the finished book is on disk → send it
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
 *  inputs — `pdfBuilt`/`delivered` are predicates, `runningOrderId` a plain id — so the whole
 *  status machine is testable without a filesystem or a running server. */
export function buildBoard(orders, { runningOrderId = null, pdfBuilt = () => false, delivered = () => false, printed = () => false, createdAt = () => null, stale = () => false, firstLiveOrder = null } = {}) {
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
      delivered: delivered(order),
      printed: printed(order),
    });
    const entry = boardEntry(order, status);
    entry.createdAt = createdAt(order); // ms since epoch, or null — drives the Stáří column (N8)
    // Only a sent order can be stale: its PDF was rebuilt after it went to Jirka (N10).
    entry.stale = status === ORDER_BOARD_STATES.SENT && stale(order);
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
 *  delivery marker. `state` is injected so a test can drive the wiring with a fake review state.
 *  `dataDir` (config.shopify.dataDir) is where the overnight report lives; when set and a report is
 *  present, the board carries the morning rollup. `readReportFn` is injected for tests. */
export function studioBoard({ inboxRoot, outboxRoot, runningOrderId = null, only = null, memoryRoot, firstLiveOrder = null, dataDir = null, state = reviewState, readReportFn = readReport } = {}) {
  const orders = state({ inboxRoot, outboxRoot, only, memoryRoot });
  const board = buildBoard(orders, {
    runningOrderId,
    firstLiveOrder,
    pdfBuilt: (o) => existsSync(pdfPathFor(o.orderDir, o.orderId)),
    delivered: (o) => existsSync(deliveredMarkerPath(o.orderDir)),
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
    // Sent-file staleness (N10): the current PDF is newer than the one recorded at send time.
    stale: (o) => {
      const marker = deliveredMarkerPath(o.orderDir);
      const pdf = pdfPathFor(o.orderDir, o.orderId);
      if (!existsSync(marker) || !existsSync(pdf)) return false;
      try {
        const { sentPdfMtime } = JSON.parse(readFileSync(marker, 'utf8'));
        return typeof sentPdfMtime === 'number' && statSync(pdf).mtimeMs > sentPdfMtime + 1000; // 1s epsilon
      } catch {
        return false;
      }
    },
  });
  const overnight = dataDir ? overnightSummary(readReportFn(dataDir)) : null;
  return { ...board, overnight };
}
