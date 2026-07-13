import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBoard, deriveOrderStatus, studioBoard, overnightSummary, ORDER_BOARD_STATES, markDelivered, unmarkDelivered, deliveredMarkerPath, markPrinted, unmarkPrinted, printedMarkerPath } from '../src/studio.js';

// Review-state-shaped fakes. buildBoard is pure over these, so the whole status machine is tested
// without a filesystem or a running server.
const summary = (o = {}) => ({ total: 0, eligible: 0, held: 0, manual: 0, failed: 0, pending: 0, ready: false, ...o });
const order = (orderId, s = summary(), extra = {}) => ({
  orderId,
  dirName: orderId,
  inInbox: true,
  intake: null,
  draftEmail: '',
  dedication: '',
  summary: s,
  ...extra,
});
const heldOrder = (orderId, draftEmail) =>
  order(orderId, summary(), {
    intake: { verdict: 'hold', override: false, unique: 5, expected: 8, findings: [{ check: 'count', verdict: 'hold' }] },
    draftEmail,
  });

// ---- deriveOrderStatus precedence -------------------------------------------

test('all-approved splits by whether the PDF exists: no book on disk = approved, book = ready-to-send, marker = sent (N1)', () => {
  const o = order('1', summary({ total: 2, eligible: 2, ready: true }));
  assert.equal(deriveOrderStatus(o, { pdfBuilt: false, delivered: false }), ORDER_BOARD_STATES.APPROVED);
  assert.equal(deriveOrderStatus(o, { pdfBuilt: true, delivered: false }), ORDER_BOARD_STATES.READY_TO_SEND);
  assert.equal(deriveOrderStatus(o, { pdfBuilt: true, delivered: true }), ORDER_BOARD_STATES.SENT);
});

test('an intake hold is held; an override on that hold releases it back into the flow', () => {
  const held = heldOrder('1', 'Komu: x');
  assert.equal(deriveOrderStatus(held), ORDER_BOARD_STATES.HELD);
  const overridden = { ...held, intake: { ...held.intake, override: true } };
  // Override + nothing generated yet -> queued, not held.
  assert.equal(deriveOrderStatus(overridden), ORDER_BOARD_STATES.QUEUED);
});

test('the active run marks its order generating; the ones behind it stay queued', () => {
  const o = order('1', summary({ total: 2, pending: 2 }));
  assert.equal(deriveOrderStatus(o, { generating: true }), ORDER_BOARD_STATES.GENERATING);
  assert.equal(deriveOrderStatus(o, { generating: false }), ORDER_BOARD_STATES.QUEUED);
});

test('a stored intake hold stops meaning held once the order has generated and built (P1 recovery)', () => {
  // The customer's replacement made intake pass; the order generated + built, but the stale hold
  // block lingered. With photos generated (pending < total) it must read ready-to-send, not held.
  const fixed = order('1479', summary({ total: 2, eligible: 2, pending: 0, ready: true }), {
    intake: { verdict: 'hold', override: false, findings: [{ check: 'count', verdict: 'hold' }] },
  });
  assert.equal(deriveOrderStatus(fixed, { pdfBuilt: true }), ORDER_BOARD_STATES.READY_TO_SEND);
  // A genuine hold — nothing generated yet (every photo still pending) — still reads held.
  const stillHeld = order('1480', summary({ total: 2, pending: 2 }), {
    intake: { verdict: 'hold', override: false, findings: [{ check: 'count', verdict: 'hold' }] },
  });
  assert.equal(deriveOrderStatus(stillHeld), ORDER_BOARD_STATES.HELD);
});

test('a part-generated order with nothing flagged is queued (resumable), not pending-review', () => {
  // A stopped run left one photo ok, one still to generate, nothing held/failed — Go finishes it.
  const partial = order('1', summary({ total: 2, eligible: 1, pending: 1 }));
  assert.equal(deriveOrderStatus(partial, { generating: false }), ORDER_BOARD_STATES.QUEUED);
});

test('a manual-repair-only order awaits the operator at pending-review', () => {
  assert.equal(deriveOrderStatus(order('1', summary({ total: 1, manual: 1 }))), ORDER_BOARD_STATES.PENDING_REVIEW);
});

test('a flagged photo holds the order at pending-review; a failed photo fails it', () => {
  assert.equal(deriveOrderStatus(order('1', summary({ total: 2, eligible: 1, held: 1 }))), ORDER_BOARD_STATES.PENDING_REVIEW);
  assert.equal(deriveOrderStatus(order('1', summary({ total: 2, eligible: 1, failed: 1 }))), ORDER_BOARD_STATES.FAILED);
});

test('the delivery marker is terminal — it wins even over a stale flagged photo state', () => {
  const o = order('1', summary({ total: 2, eligible: 1, held: 1 }));
  assert.equal(deriveOrderStatus(o, { delivered: true }), ORDER_BOARD_STATES.SENT);
});

// ---- buildBoard -------------------------------------------------------------

test('the board is oldest-first by numeric order id', () => {
  const board = buildBoard([order('1523'), order('1479'), order('1521')]);
  assert.deepEqual(board.orders.map((o) => o.orderId), ['1479', '1521', '1523']);
});

test('a held order appears in needs-you with its draft email and a reason', () => {
  const board = buildBoard([heldOrder('1523', 'Komu: h@example.cz\nPředmět: Fotky')]);
  assert.equal(board.orders[0].status, ORDER_BOARD_STATES.HELD);
  assert.equal(board.needsYou.length, 1);
  assert.equal(board.needsYou[0].orderId, '1523');
  assert.match(board.needsYou[0].draftEmail, /Komu: h@example\.cz/);
  assert.ok(board.needsYou[0].reason, 'a held card carries a why-line');
  assert.match(board.needsYou[0].reason, /5 z 8/);
});

test('a non-held order carries no draft email or reason', () => {
  const [entry] = buildBoard([order('1', summary({ total: 1, eligible: 1, ready: true }))]).orders;
  assert.equal(entry.draftEmail, '');
  assert.equal(entry.reason, null);
});

test('KPI counts tally the board by status, with a total', () => {
  const board = buildBoard(
    [
      order('1', summary({ total: 1, eligible: 1, ready: true })), // approved (all approved, no PDF on disk)
      order('2', summary({ total: 2, eligible: 1, held: 1 })), // pending-review
      heldOrder('3', 'x'), // held
      order('4', summary({ total: 1, pending: 1 })), // queued
    ],
  );
  assert.equal(board.counts.total, 4);
  assert.equal(board.counts[ORDER_BOARD_STATES.APPROVED], 1);
  assert.equal(board.counts[ORDER_BOARD_STATES.READY_TO_SEND], 0);
  assert.equal(board.counts[ORDER_BOARD_STATES.PENDING_REVIEW], 1);
  assert.equal(board.counts[ORDER_BOARD_STATES.HELD], 1);
  assert.equal(board.counts[ORDER_BOARD_STATES.QUEUED], 1);
  assert.equal(board.counts[ORDER_BOARD_STATES.SENT], 0);
});

test('an empty inbox is an empty board, not an error', () => {
  const board = buildBoard([]);
  assert.deepEqual(board.orders, []);
  assert.deepEqual(board.needsYou, []);
  assert.equal(board.counts.total, 0);
  assert.equal(board.counts[ORDER_BOARD_STATES.QUEUED], 0);
});

test('the PDF and marker are injected per order — one order built, another delivered, a third queued', () => {
  const built = new Set(['1521']);
  const sent = new Set(['1523']);
  const board = buildBoard([order('1521', summary({ total: 1, eligible: 1, ready: true })), order('1522', summary({ total: 1, pending: 1 })), order('1523', summary({ total: 1, eligible: 1, ready: true }))], {
    pdfBuilt: (o) => built.has(o.orderId),
    delivered: (o) => sent.has(o.orderId),
  });
  const status = Object.fromEntries(board.orders.map((o) => [o.orderId, o.status]));
  assert.equal(status['1521'], ORDER_BOARD_STATES.READY_TO_SEND);
  assert.equal(status['1522'], ORDER_BOARD_STATES.QUEUED);
  assert.equal(status['1523'], ORDER_BOARD_STATES.SENT);
});

// ---- studioBoard: the real filesystem wiring (pdfPathFor + marker) ----------

test('studioBoard reads the built PDF and delivery marker off disk by the tool\'s own naming', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-studio-'));
  try {
    const outbox = join(root, 'outbox');
    const dir = (id) => {
      const d = join(outbox, id);
      mkdirSync(d, { recursive: true });
      return d;
    };
    const d1521 = dir('1521');
    const d1523 = dir('1523');
    dir('1522');
    writeFileSync(join(d1521, '1521 Final.pdf'), '%PDF-1.4\n'); // built, no marker -> ready-to-send
    writeFileSync(join(d1523, '1523 Final.pdf'), '%PDF-1.4\n');
    writeFileSync(join(d1523, 'delivered.json'), '{}'); // marker present -> sent

    // Inject a fake review state so the test owns the order set; the PDF/marker reads are real.
    const fakeState = () => [
      order('1521', summary({ total: 1, eligible: 1, ready: true }), { orderDir: d1521 }),
      order('1522', summary({ total: 1, pending: 1 }), { orderDir: join(outbox, '1522') }),
      order('1523', summary({ total: 1, eligible: 1, ready: true }), { orderDir: d1523 }),
    ];
    const board = studioBoard({ inboxRoot: null, outboxRoot: outbox, state: fakeState });
    const status = Object.fromEntries(board.orders.map((o) => [o.orderId, o.status]));
    assert.equal(status['1521'], ORDER_BOARD_STATES.READY_TO_SEND);
    assert.equal(status['1522'], ORDER_BOARD_STATES.QUEUED);
    assert.equal(status['1523'], ORDER_BOARD_STATES.SENT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- firstLiveOrder floor + delivery marker --------------------------------

test('firstLiveOrder hides test orders below it; counts follow, non-numeric ids are kept', () => {
  const board = buildBoard([order('1231'), order('1524'), order('1525'), order('draft-x')], { firstLiveOrder: 1524 });
  assert.deepEqual(board.orders.map((o) => o.orderId), ['1524', '1525', 'draft-x']); // 1231 dropped, letters kept
  assert.equal(board.counts.total, 3);
  // With no floor, nothing is hidden — the default must not change existing behaviour.
  assert.equal(buildBoard([order('1231'), order('1524')]).counts.total, 2);
});

test('markDelivered writes the terminal marker (sent); unmarkDelivered removes it and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-mark-'));
  try {
    const dir = join(root, '1525');
    mkdirSync(dir, { recursive: true });
    assert.equal(existsSync(deliveredMarkerPath(dir)), false);

    assert.equal(markDelivered(dir), ORDER_BOARD_STATES.SENT);
    assert.equal(existsSync(deliveredMarkerPath(dir)), true);
    const marker = JSON.parse(readFileSync(deliveredMarkerPath(dir), 'utf8'));
    assert.equal(marker.by, 'operator');
    assert.ok(marker.at, 'the marker is timestamped');

    unmarkDelivered(dir);
    assert.equal(existsSync(deliveredMarkerPath(dir)), false);
    unmarkDelivered(dir); // no marker present -> must not throw
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('markPrinted writes the printed marker; the printed verdict is terminal and outranks sent (N3)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-printed-'));
  try {
    const dir = join(root, '1525');
    mkdirSync(dir, { recursive: true });
    assert.equal(markPrinted(dir), ORDER_BOARD_STATES.PRINTED);
    assert.equal(existsSync(printedMarkerPath(dir)), true);
    assert.ok(JSON.parse(readFileSync(printedMarkerPath(dir), 'utf8')).at, 'the marker is timestamped');

    // printed wins even when the delivery marker is also present.
    const o = order('1525', summary({ total: 1, eligible: 1, ready: true }));
    assert.equal(deriveOrderStatus(o, { pdfBuilt: true, delivered: true, printed: true }), ORDER_BOARD_STATES.PRINTED);
    assert.equal(deriveOrderStatus(o, { pdfBuilt: true, delivered: true, printed: false }), ORDER_BOARD_STATES.SENT);

    unmarkPrinted(dir);
    assert.equal(existsSync(printedMarkerPath(dir)), false);
    unmarkPrinted(dir); // idempotent
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- overnight rollup (U5): the morning summary from the night report -------

test('overnightSummary distils a report to counts + ranAt + count + spend', () => {
  const report = {
    ranAt: '2026-07-12T04:12:00.000Z',
    counts: { ready: 4, held: 1, failed: 0 },
    processed: 5,
    estSpend: 1.5,
    orders: [{ orderId: '1600', status: 'ready' }],
  };
  assert.deepEqual(overnightSummary(report), {
    ranAt: '2026-07-12T04:12:00.000Z',
    orders: { ready: 4, held: 1, failed: 0 },
    count: 5,
    estSpend: 1.5,
  });
});

test('overnightSummary is null when there is no report (a manual-only day)', () => {
  assert.equal(overnightSummary(null), null);
  assert.equal(overnightSummary(undefined), null);
});

test('overnightSummary falls back to summed counts when processed is missing, and tolerates gaps', () => {
  const s = overnightSummary({ counts: { ready: 2, failed: 1 } });
  assert.equal(s.count, 3, 'count falls back to ready+held+failed');
  assert.equal(s.orders.held, 0, 'a missing sub-count reads as zero');
  assert.equal(s.estSpend, null, 'a missing spend reads as null, not 0');
  assert.equal(s.ranAt, null);
});

test('studioBoard carries the overnight block when a report is present, and null when dataDir is unset', () => {
  const fakeState = () => [order('1600', summary({ total: 1, eligible: 1, ready: true }), { orderDir: '/x/1600' })];
  const report = { ranAt: '2026-07-12T04:00:00Z', counts: { ready: 1, held: 0, failed: 0 }, processed: 1, estSpend: 0.3 };

  const withReport = studioBoard({ inboxRoot: null, outboxRoot: null, state: fakeState, dataDir: '/data', readReportFn: () => report });
  assert.equal(withReport.overnight.orders.ready, 1);
  assert.equal(withReport.overnight.estSpend, 0.3);

  // No dataDir -> the report is never read and the board simply carries no overnight block (R9).
  const noDir = studioBoard({ inboxRoot: null, outboxRoot: null, state: fakeState });
  assert.equal(noDir.overnight, null);

  // dataDir set but no report on disk -> still null, dashboard renders normally.
  const noReport = studioBoard({ inboxRoot: null, outboxRoot: null, state: fakeState, dataDir: '/data', readReportFn: () => null });
  assert.equal(noReport.overnight, null);
});
