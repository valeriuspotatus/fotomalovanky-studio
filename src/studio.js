import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { reviewState } from './review.js';
import { pdfPathFor } from './orchestrator.js';
import { intakeSummary } from './intake.js';

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

/** The order-level board statuses. Distinct from the per-photo STATES and from the photo-level
 *  `handoff` (manual repair) — this is where the whole order sits on its way to Jirka. */
export const ORDER_BOARD_STATES = Object.freeze({
  QUEUED: 'queued',
  GENERATING: 'generating',
  HELD: 'held',
  PENDING_REVIEW: 'pending-review',
  READY_TO_SEND: 'ready-to-send',
  SENT: 'sent',
  FAILED: 'failed',
});

/** One order's board status from its review state plus the three injected facts. Pure.
 *
 *  Order matters: the delivery marker is terminal, an intake hold outranks generation (a held
 *  order never generates), and a live run on this order beats any half-finished photo state. */
export function deriveOrderStatus(order, { generating = false, pdfBuilt = false, delivered = false } = {}) {
  const s = order.summary ?? { total: 0, eligible: 0, held: 0, manual: 0, failed: 0, pending: 0, ready: false };
  const intakeHeld = order.intake?.verdict === 'hold' && order.intake?.override !== true;

  if (delivered) return ORDER_BOARD_STATES.SENT; // the marker is idempotent — a sent order stays sent
  if (intakeHeld) return ORDER_BOARD_STATES.HELD; // surfaces under Potřebuje vás with its draft email
  if (generating) return ORDER_BOARD_STATES.GENERATING; // the run is on this order right now
  if (s.failed > 0) return ORDER_BOARD_STATES.FAILED;
  if (s.held > 0 || s.manual > 0) return ORDER_BOARD_STATES.PENDING_REVIEW; // a photo awaits the operator
  if (s.ready || pdfBuilt) return ORDER_BOARD_STATES.READY_TO_SEND; // all approved, or a book already on disk
  if (s.total > s.pending) return ORDER_BOARD_STATES.PENDING_REVIEW; // part-generated, not the active order
  return ORDER_BOARD_STATES.QUEUED; // in the inbox, nothing generated yet
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
  return 'input problem — waiting for you';
}

/** One order's board entry — the shape the dashboard renders. Filesystem paths are deliberately
 *  left out: the read board addresses orders by id, and a held order's email is the only order
 *  content the browser needs. */
function boardEntry(order, status) {
  const s = order.summary ?? {};
  const held = status === ORDER_BOARD_STATES.HELD;
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
    // Only a held order carries an email to send and a reason; everything else omits them.
    reason: held ? heldReason(order) : null,
    draftEmail: held ? order.draftEmail || '' : '',
  };
}

/** Build the whole board from review-state orders plus injected fact-providers. Pure over its
 *  inputs — `pdfBuilt`/`delivered` are predicates, `runningOrderId` a plain id — so the whole
 *  status machine is testable without a filesystem or a running server. */
export function buildBoard(orders, { runningOrderId = null, pdfBuilt = () => false, delivered = () => false } = {}) {
  const board = orders.map((order) => {
    const status = deriveOrderStatus(order, {
      generating: runningOrderId != null && order.orderId === runningOrderId,
      pdfBuilt: pdfBuilt(order),
      delivered: delivered(order),
    });
    return boardEntry(order, status);
  });

  // Oldest-first: the operator works the queue in the order the customers sent it.
  board.sort((a, b) => a.orderId.localeCompare(b.orderId, 'en', { numeric: true }));

  const counts = { total: board.length };
  for (const state of Object.values(ORDER_BOARD_STATES)) counts[state] = 0;
  for (const entry of board) counts[entry.status] += 1;

  const needsYou = board.filter((entry) => entry.status === ORDER_BOARD_STATES.HELD);
  return { orders: board, counts, needsYou };
}

/** The live board over a real inbox/outbox: reads the review state and stats each order's PDF and
 *  delivery marker. `state` is injected so a test can drive the wiring with a fake review state. */
export function studioBoard({ inboxRoot, outboxRoot, runningOrderId = null, only = null, memoryRoot, state = reviewState } = {}) {
  const orders = state({ inboxRoot, outboxRoot, only, memoryRoot });
  return buildBoard(orders, {
    runningOrderId,
    pdfBuilt: (o) => existsSync(pdfPathFor(o.orderDir, o.orderId)),
    delivered: (o) => existsSync(deliveredMarkerPath(o.orderDir)),
  });
}
