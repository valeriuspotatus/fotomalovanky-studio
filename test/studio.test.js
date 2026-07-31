import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBoard, deriveOrderStatus, studioBoard, overnightSummary, ORDER_BOARD_STATES, markSent, unmarkSent, sentMarkerPath, readSentMarker, markPrinted, unmarkPrinted, printedMarkerPath } from '../src/studio.js';

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

test('all-approved splits by whether the PDF exists: no book on disk = approved, book = ready-to-print, marker = sent (N1)', () => {
  const o = order('1', summary({ total: 2, eligible: 2, ready: true }));
  assert.equal(deriveOrderStatus(o, { pdfBuilt: false }), ORDER_BOARD_STATES.APPROVED);
  assert.equal(deriveOrderStatus(o, { pdfBuilt: true }), ORDER_BOARD_STATES.READY_TO_PRINT);
  assert.equal(deriveOrderStatus(o, { pdfBuilt: true, printed: true, sent: true }), ORDER_BOARD_STATES.SENT);
});

test('the re-cut lifecycle: dispatch outranks print, and print no longer ends the order (R14, R15)', () => {
  const o = order('1', summary({ total: 2, eligible: 2, ready: true }));
  // Printed but not posted: the operator still has something to do, so it is NOT terminal.
  assert.equal(deriveOrderStatus(o, { pdfBuilt: true, printed: true }), ORDER_BOARD_STATES.PRINTED, 'printed, awaiting dispatch');
  // Dispatched wins over printed — the reverse of the old machine, where printed outranked sent.
  assert.equal(deriveOrderStatus(o, { pdfBuilt: true, printed: true, sent: true }), ORDER_BOARD_STATES.SENT, 'dispatch is terminal');
  // Dispatch is terminal even over a stale flagged photo state.
  const flagged = order('1', summary({ total: 2, eligible: 1, held: 1 }));
  assert.equal(deriveOrderStatus(flagged, { sent: true }), ORDER_BOARD_STATES.SENT, 'the dispatch marker is the last word');
});

test('a BACKFILLED dispatch marker reads as printed, never as dispatched (KTD7)', () => {
  // The migration wrote this marker from printed.json to preserve the purge date (R17). Nobody
  // confirmed the book was posted, so it must stay in the operator's worklist.
  const o = order('1', summary({ total: 2, eligible: 2, ready: true }));
  assert.equal(
    deriveOrderStatus(o, { pdfBuilt: true, printed: true, sent: true, sentBackfilled: true }),
    ORDER_BOARD_STATES.PRINTED,
    'a backfilled marker is "printed, dispatch unknown" — not terminal',
  );
  // Confirmed by hand afterwards (the flag goes away) → terminal.
  assert.equal(
    deriveOrderStatus(o, { pdfBuilt: true, printed: true, sent: true, sentBackfilled: false }),
    ORDER_BOARD_STATES.SENT,
    'once the operator confirms it, it is a dispatch like any other',
  );
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
  // block lingered. With photos generated (pending < total) it must read ready-to-print, not held.
  const fixed = order('1479', summary({ total: 2, eligible: 2, pending: 0, ready: true }), {
    intake: { verdict: 'hold', override: false, findings: [{ check: 'count', verdict: 'hold' }] },
  });
  assert.equal(deriveOrderStatus(fixed, { pdfBuilt: true }), ORDER_BOARD_STATES.READY_TO_PRINT);
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

test('board entry carries the product page count, missing photos, and injected order age (N8)', () => {
  const held = order('1724', summary({ total: 1, eligible: 0, pending: 1 }), {
    intake: { verdict: 'hold', override: false, findings: [{ check: 'count', verdict: 'hold', expected: 2, unique: 1, missing: 1 }] },
  });
  const [entry] = buildBoard([held], { createdAt: () => 1_000_000 }).orders;
  assert.equal(entry.status, ORDER_BOARD_STATES.HELD);
  assert.equal(entry.expectedPages, 2, 'the product page count drives the Stránky denominator');
  assert.equal(entry.missingPhotos, 1);
  assert.equal(entry.createdAt, 1_000_000, 'the injected age flows onto the entry');

  // A complete order has no count finding, so the denominator falls back to photos on hand.
  const [done] = buildBoard([order('1', summary({ total: 2, eligible: 2, ready: true }))]).orders;
  assert.equal(done.expectedPages, null);
  assert.equal(done.missingPhotos, null);
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
  assert.equal(board.counts[ORDER_BOARD_STATES.READY_TO_PRINT], 0);
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

test('the PDF and markers are injected per order — one built, one dispatched, a third queued', () => {
  const built = new Set(['1521', '1523']);
  const sent = new Set(['1523']);
  const board = buildBoard([order('1521', summary({ total: 1, eligible: 1, ready: true })), order('1522', summary({ total: 1, pending: 1 })), order('1523', summary({ total: 1, eligible: 1, ready: true }))], {
    pdfBuilt: (o) => built.has(o.orderId),
    sent: (o) => sent.has(o.orderId),
  });
  const status = Object.fromEntries(board.orders.map((o) => [o.orderId, o.status]));
  assert.equal(status['1521'], ORDER_BOARD_STATES.READY_TO_PRINT);
  assert.equal(status['1522'], ORDER_BOARD_STATES.QUEUED);
  assert.equal(status['1523'], ORDER_BOARD_STATES.SENT);
});

// ---- studioBoard: the real filesystem wiring (pdfPathFor + marker) ----------

test('studioBoard reads the built PDF and the two lifecycle markers off disk by the tool\'s own naming', () => {
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
    const d1524 = dir('1524');
    dir('1522');
    writeFileSync(join(d1521, '1521 Final.pdf'), '%PDF-1.4\n'); // built, no marker -> ready-to-print
    writeFileSync(join(d1523, '1523 Final.pdf'), '%PDF-1.4\n');
    writeFileSync(join(d1523, 'printed.json'), '{}'); // printed, not posted -> printed
    writeFileSync(join(d1524, '1524 Final.pdf'), '%PDF-1.4\n');
    writeFileSync(join(d1524, 'printed.json'), '{}');
    writeFileSync(join(d1524, 'sent.json'), '{}'); // posted to the customer -> sent

    // Inject a fake review state so the test owns the order set; the PDF/marker reads are real.
    const fakeState = () => [
      order('1521', summary({ total: 1, eligible: 1, ready: true }), { orderDir: d1521 }),
      order('1522', summary({ total: 1, pending: 1 }), { orderDir: join(outbox, '1522') }),
      order('1523', summary({ total: 1, eligible: 1, ready: true }), { orderDir: d1523 }),
      order('1524', summary({ total: 1, eligible: 1, ready: true }), { orderDir: d1524 }),
    ];
    const board = studioBoard({ inboxRoot: null, outboxRoot: outbox, state: fakeState });
    const status = Object.fromEntries(board.orders.map((o) => [o.orderId, o.status]));
    assert.equal(status['1521'], ORDER_BOARD_STATES.READY_TO_PRINT);
    assert.equal(status['1522'], ORDER_BOARD_STATES.QUEUED);
    assert.equal(status['1523'], ORDER_BOARD_STATES.PRINTED);
    assert.equal(status['1524'], ORDER_BOARD_STATES.SENT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AE8 — an order carrying only the OLD delivery marker does not read as dispatched, and the file is left alone (R16, KTD6)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-legacy-'));
  try {
    const outbox = join(root, 'outbox');
    const d = join(outbox, '1700');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '1700 Final.pdf'), '%PDF-1.4\n');
    // Written under the OLD meaning: "handed to Jirka", which now sits BEFORE printing. This book is
    // still waiting for the printer; reading it as a dispatch would post it to a customer on paper only.
    const legacy = join(d, 'delivered.json');
    writeFileSync(legacy, JSON.stringify({ at: '2026-01-02T03:04:05.000Z', by: 'operator' }));
    const before = readFileSync(legacy, 'utf8');

    const fakeState = () => [order('1700', summary({ total: 1, eligible: 1, ready: true }), { orderDir: d })];
    const board = studioBoard({ inboxRoot: null, outboxRoot: outbox, state: fakeState });
    assert.equal(board.orders[0].status, ORDER_BOARD_STATES.READY_TO_PRINT, 'it is awaiting print, not dispatched');
    assert.equal(existsSync(join(d, 'sent.json')), false, 'reading the board writes no dispatch marker');
    assert.equal(readFileSync(legacy, 'utf8'), before, 'the retired marker is left exactly as it was on disk');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('studioBoard treats a BACKFILLED dispatch marker on disk as printed, and an unreadable one the same way', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-backfilled-'));
  try {
    const outbox = join(root, 'outbox');
    const mk = (id, sentJson) => {
      const d = join(outbox, id);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, `${id} Final.pdf`), '%PDF-1.4\n');
      writeFileSync(join(d, 'printed.json'), '{}');
      writeFileSync(join(d, 'sent.json'), sentJson);
      return d;
    };
    const backfilled = mk('1800', JSON.stringify({ at: '2026-01-01T00:00:00.000Z', backfilled: true }));
    const confirmed = mk('1801', JSON.stringify({ at: '2026-01-01T00:00:00.000Z' }));
    const broken = mk('1802', '{not json');

    const fakeState = () => [
      order('1800', summary({ total: 1, eligible: 1, ready: true }), { orderDir: backfilled }),
      order('1801', summary({ total: 1, eligible: 1, ready: true }), { orderDir: confirmed }),
      order('1802', summary({ total: 1, eligible: 1, ready: true }), { orderDir: broken }),
    ];
    const status = Object.fromEntries(
      studioBoard({ inboxRoot: null, outboxRoot: outbox, state: fakeState }).orders.map((o) => [o.orderId, o.status]),
    );
    assert.equal(status['1800'], ORDER_BOARD_STATES.PRINTED, 'backfilled: nobody confirmed the post, so it stays on the worklist');
    assert.equal(status['1801'], ORDER_BOARD_STATES.SENT, 'a real dispatch marker is terminal');
    assert.equal(status['1802'], ORDER_BOARD_STATES.PRINTED, 'an unreadable marker is not evidence of a dispatch');

    assert.deepEqual(readSentMarker(backfilled), { backfilled: true });
    assert.deepEqual(readSentMarker(confirmed), { backfilled: false });
    assert.equal(readSentMarker(join(outbox, 'nope')), null, 'no marker reads as null, not as a dispatch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every board status the server can produce has an operator-facing label in the dashboard', () => {
  // The browser smoke asserts this against the live page; this is the cheap offline half, so a state
  // renamed in studio.js cannot ship as a raw grey key nobody can read (`ready-to-print` was).
  const page = readFileSync(new URL('../src/ui/static/dashboard.html', import.meta.url), 'utf8');
  const map = page.slice(page.indexOf('const STATUS={'), page.indexOf('const statusMeta='));
  for (const state of Object.values(ORDER_BOARD_STATES)) {
    assert.match(map, new RegExp(`["']?${state}["']?:\\s*\\{label:`), `the dashboard labels "${state}"`);
  }
  assert.match(map, /"ready-to-print":\s*\{label:"připraveno k tisku"/, 'a built book now waits for the PRINTER');
  assert.match(map, /sent:\s*\{label:"odesláno zákazníkovi"/, 'and "odesláno" now says who it went to (R14)');
});

// ---- firstLiveOrder floor + delivery marker --------------------------------

test('firstLiveOrder hides test orders below it; counts follow, non-numeric ids are kept', () => {
  const board = buildBoard([order('1231'), order('1524'), order('1525'), order('draft-x')], { firstLiveOrder: 1524 });
  assert.deepEqual(board.orders.map((o) => o.orderId), ['1524', '1525', 'draft-x']); // 1231 dropped, letters kept
  assert.equal(board.counts.total, 3);
  // With no floor, nothing is hidden — the default must not change existing behaviour.
  assert.equal(buildBoard([order('1231'), order('1524')]).counts.total, 2);
});

test('a printed order whose PDF is rebuilt afterwards reads as stale (N10, re-scoped to the print)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-stale-'));
  try {
    const outbox = join(root, 'outbox');
    const d = join(outbox, '1719');
    mkdirSync(d, { recursive: true });
    const pdf = join(d, '1719 Final.pdf');
    writeFileSync(pdf, '%PDF printed version');
    markPrinted(d);

    const fakeState = () => [order('1719', summary({ total: 1, eligible: 1, ready: true }), { orderDir: d })];
    let board = studioBoard({ inboxRoot: null, outboxRoot: outbox, state: fakeState });
    assert.equal(board.orders[0].status, ORDER_BOARD_STATES.PRINTED);
    assert.equal(board.orders[0].stale, false, 'just printed — the paper matches the book on disk');

    // Rebuild the book after it was printed: the printed copy is no longer what the decisions say.
    writeFileSync(pdf, '%PDF rebuilt version');
    const later = (statSync(pdf).mtimeMs + 5000) / 1000;
    utimesSync(pdf, later, later);
    board = studioBoard({ inboxRoot: null, outboxRoot: outbox, state: fakeState });
    assert.equal(board.orders[0].stale, true, 'rebuilt after the print — the printed book is out of date');

    // It survives dispatch: the customer may need a corrected copy, which is the operator's call.
    markSent(d);
    board = studioBoard({ inboxRoot: null, outboxRoot: outbox, state: fakeState });
    assert.equal(board.orders[0].status, ORDER_BOARD_STATES.SENT);
    assert.equal(board.orders[0].stale, true, 'a dispatched order carrying an out-of-date print still says so');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('markSent writes the terminal dispatch marker to sent.json; unmarkSent removes it and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-mark-'));
  try {
    const dir = join(root, '1525');
    mkdirSync(dir, { recursive: true });
    assert.equal(existsSync(sentMarkerPath(dir)), false);
    assert.equal(sentMarkerPath(dir), join(dir, 'sent.json'), 'a file of its own — never the retired delivered.json');

    assert.equal(markSent(dir), ORDER_BOARD_STATES.SENT);
    assert.equal(existsSync(sentMarkerPath(dir)), true);
    assert.equal(existsSync(join(dir, 'delivered.json')), false, 'and the old marker is not written either');
    const marker = JSON.parse(readFileSync(sentMarkerPath(dir), 'utf8'));
    assert.equal(marker.by, 'operator');
    assert.ok(marker.at, 'the marker is timestamped');
    assert.notEqual(marker.backfilled, true, 'a dispatch the operator performed is not a backfill');

    unmarkSent(dir);
    assert.equal(existsSync(sentMarkerPath(dir)), false);
    unmarkSent(dir); // no marker present -> must not throw
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('markPrinted writes the printed marker; undoing a dispatch returns the order to printed', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-printed-'));
  try {
    const outbox = join(root, 'outbox');
    const dir = join(outbox, '1525');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '1525 Final.pdf'), '%PDF-1.4\n');
    assert.equal(markPrinted(dir), ORDER_BOARD_STATES.PRINTED);
    assert.equal(existsSync(printedMarkerPath(dir)), true);
    assert.ok(JSON.parse(readFileSync(printedMarkerPath(dir), 'utf8')).at, 'the marker is timestamped');

    const fakeState = () => [order('1525', summary({ total: 1, eligible: 1, ready: true }), { orderDir: dir })];
    const statusNow = () => studioBoard({ inboxRoot: null, outboxRoot: outbox, state: fakeState }).orders[0].status;
    assert.equal(statusNow(), ORDER_BOARD_STATES.PRINTED);

    markSent(dir);
    assert.equal(statusNow(), ORDER_BOARD_STATES.SENT);
    unmarkSent(dir);
    assert.equal(statusNow(), ORDER_BOARD_STATES.PRINTED, 'undoing a dispatch drops back to printed, not to the start');

    unmarkPrinted(dir);
    assert.equal(existsSync(printedMarkerPath(dir)), false);
    assert.equal(statusNow(), ORDER_BOARD_STATES.READY_TO_PRINT);
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
