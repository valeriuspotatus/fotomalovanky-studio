import { existsSync, writeFileSync, rmSync, statSync, readFileSync, utimesSync } from 'node:fs';
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

// WHO WROTE THE MARKER (R9, U8).
//
// `by: 'operator'` used to be a constant: both writers accepted caller-supplied info and every call
// site omitted it, so a marker written by Jirka and one written by David were byte-identical in the
// one field that was supposed to tell them apart. Splitting `printed` (the printer's act) from
// `sent` (the operator's) is pointless if the audit trail cannot say who did which — that split IS
// the reason there are two accounts at all.
//
// Two fields, not one. `by` is the DISPLAY NAME the person chose and may change tomorrow (R11);
// `byRole` is the role, which cannot change and is therefore the field anything mechanical should
// read. Storing only the name would leave a renamed account's old markers unattributable; storing
// only the role would lose the person.

/** The one identity a local ungated studio has (KTD11). Nobody signs in there, so there is no
 *  display name to record and the marker reads exactly as it always did before per-user logins. */
export const IMPLICIT_ACTOR = Object.freeze({ by: 'operator', byRole: 'operator' });

/** The actor fields for a marker, from a resolved request identity (`{ role, username, implicit }`).
 *  Total: an absent, implicit or unrecognisable identity falls back to the implicit operator rather
 *  than throwing — a marker that cannot be attributed must still be writable, because refusing to
 *  record that a book was printed is worse than recording it against nobody in particular. */
export function markerActor(identity = null) {
  if (!identity || identity.implicit === true) return { ...IMPLICIT_ACTOR };
  const byRole = identity.role === 'printer' ? 'printer' : 'operator';
  const named = typeof identity.username === 'string' ? identity.username.trim() : '';
  return { by: named || byRole, byRole };
}

/** What a marker file says about who wrote it, or null when there is nothing recognisable there.
 *
 *  Every failure mode answers null rather than throwing: markers written before this change carry
 *  `by: 'operator'` and no role, markers on the live disk may predate even that, and a hand-edited
 *  or truncated file is not an error the board should die of. A caller that wants "somebody, we
 *  don't know who" gets it as null and can say so. */
export function readMarkerActor(markerPath) {
  if (!existsSync(markerPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const by = typeof parsed.by === 'string' && parsed.by.trim() ? parsed.by.trim() : null;
  if (!by) return null;
  const byRole = parsed.byRole === 'printer' || parsed.byRole === 'operator' ? parsed.byRole : null;
  return { by, byRole };
}

/** The dispatch marker: the finished book was posted to the CUSTOMER (R14). A DISTINCT filename
 *  from the retired `delivered.json` — see the note above; the two mean different things and must
 *  never share a path. Its presence is the source of truth for 'sent'. */
export const sentMarkerPath = (orderDir) => join(orderDir, 'sent.json');

/** The operator confirms a printed book has gone into the post: write the terminal dispatch marker
 *  so the order derives to 'sent' and drops off the active board. This is a MANUAL acknowledgement
 *  and the ONLY way the marker is ever written — nothing in this tool posts anything to anyone; it
 *  only records that the operator already did. Idempotent.
 *
 *  `identity` is the resolved request identity of whoever clicked (R9). Omitted → the implicit
 *  operator, which is what an ungated local studio and every non-HTTP caller are. */
export function markSent(orderDir, identity = null) {
  const path = sentMarkerPath(orderDir);

  // THE RETENTION CLOCK SURVIVES THE CONFIRMATION (R17, KTD7).
  //
  // retention.js measures an order's age from this file's MTIME, and the U10 migration `utimesSync`d
  // every backfilled marker back to the print date precisely so the historical backlog kept the
  // eligibility date it already had. But a backfilled order renders as `printed` with exactly one
  // CTA — "Označit odeslané" — so the moment the operator works that backlog he passes through here.
  // A plain write would stamp today's mtime on every one of them and restart the whole backlog's
  // retention window at zero: R17 undone by the operator doing the thing the board asked him to do.
  //
  // So when the marker being replaced was backfilled, its mtime is put back afterwards. The file's
  // CONTENT is the new truth (the operator's name, and no `backfilled` flag — this dispatch is now
  // confirmed); the file's DATE is the old truth, and it is still true: confirming that a book left
  // does not change when it left.
  //
  // Only for a backfilled marker. Re-confirming an ordinary dispatch is the operator correcting who
  // or when, and that legitimately re-dates the marker.
  const previous = readSentMarker(orderDir);
  const keepClock = previous?.backfilled === true ? statSync(path) : null;

  writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...markerActor(identity) }, null, 2));
  if (keepClock) utimesSync(path, keepClock.atime, keepClock.mtime);
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
 *  migration copies onto a backfilled dispatch marker, so retention cannot restart at zero.
 *
 *  `identity` is who clicked (R9) — normally the printer here, which is the whole point of
 *  recording it: this marker and the dispatch marker must name different people. */
export function markPrinted(orderDir, identity = null) {
  writeFileSync(
    printedMarkerPath(orderDir),
    JSON.stringify({ at: new Date().toISOString(), ...markerActor(identity) }, null, 2),
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
    // Channel and campaign only — the board is a screen, and the raw source can be a full URL.
    // Null when nothing has recorded a source for this order: the row still reads "bez zdroje"
    // either way, but only a null can still be filled in, and the backfill offer keys on that.
    attribution: order.attribution
      ? { channel: order.attribution.channel ?? 'unknown', campaign: order.attribution.campaign ?? null }
      : null,
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
    // Which book of a parcel this is, and how many copies to print. Both null in the ordinary case
    // — one book, one copy — so a single-book order's row renders exactly as it did before books
    // could be split. `siblingPending` is filled in by buildBoard, which is the only place that can
    // see the other books of the same purchase.
    purchase: order.purchase?.of > 1 ? { ...order.purchase } : null,
    copies: order.copies > 1 ? order.copies : null,
    siblingPending: null,
  };
}

/** Board states in which a book is not yet ready to leave with its parcel. Dispatching one book
 *  while another is in any of these means half a parcel goes to the customer.
 *
 *  READY_TO_PRINT belongs here, and did not under the old lifecycle. Back then the terminal act was
 *  the print and this state meant "about to be handed over"; now the terminal act is the POST, and a
 *  book that exists as a PDF but has not been through the press cannot go in the parcel. Without it
 *  the one case the warning exists for — book 1 printed, book 2 still only built — passed silently. */
const NOT_READY_TO_LEAVE = new Set([
  ORDER_BOARD_STATES.QUEUED,
  ORDER_BOARD_STATES.GENERATING,
  ORDER_BOARD_STATES.HELD,
  ORDER_BOARD_STATES.PENDING_REVIEW,
  ORDER_BOARD_STATES.APPROVED,
  ORDER_BOARD_STATES.READY_TO_PRINT,
  ORDER_BOARD_STATES.FAILED,
]);

/** Fill in each entry's `siblingPending`: the other books of the same purchase that are not ready
 *  to leave yet. The two books of one purchase ship in one parcel, and marking one printed or sent
 *  acts on a single folder with no knowledge of the other — so the board is where the operator
 *  gets told. Advisory only: it names the problem and leaves the decision alone. */
function linkSiblings(board) {
  const byPurchase = new Map();
  for (const entry of board) {
    if (!entry.purchase) continue;
    const key = entry.purchase.orderId;
    if (!byPurchase.has(key)) byPurchase.set(key, []);
    byPurchase.get(key).push(entry);
  }
  for (const siblings of byPurchase.values()) {
    for (const entry of siblings) {
      const waiting = siblings
        .filter((other) => other.orderId !== entry.orderId && NOT_READY_TO_LEAVE.has(other.status))
        .map((other) => ({ orderId: other.orderId, position: other.purchase.position, status: other.status }));
      entry.siblingPending = waiting.length ? waiting : null;
    }
  }
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

  // Books of one purchase can only be related to each other once every entry has a status.
  linkSiblings(board);

  // Oldest-first: the operator works the queue in the order the customers sent it.
  board.sort((a, b) => a.orderId.localeCompare(b.orderId, 'en', { numeric: true }));

  const counts = { total: board.length };
  for (const state of Object.values(ORDER_BOARD_STATES)) counts[state] = 0;
  for (const entry of board) counts[entry.status] += 1;

  const needsYou = board.filter((entry) => entry.status === ORDER_BOARD_STATES.HELD);
  return { orders: board, counts, needsYou, printQueue: printQueue(board) };
}

/** Jirka's queue (R10, U12): every order whose book is BUILT and which nobody has printed yet.
 *
 *  Derived from the board's own status rather than re-reading the markers, so the queue can never
 *  disagree with the board about an order — READY_TO_PRINT already means exactly "the PDF is on
 *  disk and no printed marker exists", and it already loses to every state that should keep a book
 *  off the press: a dispatched or printed order has left the queue, an intake hold or a flagged
 *  photo means the book on disk is not the book to print, and an order with no PDF yet is not a
 *  book at all.
 *
 *  This is what replaced "Odeslat Jirkovi". With WhatsApp gone nothing hands a finished book to the
 *  printer, so without this view an order awaiting print is just one status among nine on a board
 *  he has no other reason to read.
 *
 *  Newest first — the opposite of the board it is derived from. The board is a backlog, read oldest
 *  first so nothing rots at the bottom; this is a work list, and the book that just finished is the
 *  one to print next. Sorted on the copy `filter` returns, so the board's own order is untouched. */
export function printQueue(entries) {
  return entries
    .filter((entry) => entry.status === ORDER_BOARD_STATES.READY_TO_PRINT)
    .sort((a, b) => b.orderId.localeCompare(a.orderId, 'en', { numeric: true }));
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
