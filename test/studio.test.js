import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBoard, deriveOrderStatus, studioBoard, overnightSummary, ORDER_BOARD_STATES, markSent, unmarkSent, sentMarkerPath, readSentMarker, markPrinted, unmarkPrinted, printedMarkerPath, markerActor, readMarkerActor, printQueue } from '../src/studio.js';
import { createReviewServer } from '../src/ui/server.js';
import { hashPassword, ROLE_ENV_VARS } from '../src/auth/credentials.js';
import { SIGN_IN_PATH } from '../src/auth/sessions.js';
import { emptyManifest, setStatus, writeManifest, STATES } from '../src/manifest.js';

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

// ---- who wrote the marker (R9, U8) -----------------------------------------

test('a marker names the person who wrote it — by display name AND by role', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-actor-'));
  try {
    const dir = join(root, '1600');
    mkdirSync(dir, { recursive: true });
    const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

    markPrinted(dir, { role: 'printer', username: 'Jirka', implicit: false });
    markSent(dir, { role: 'operator', username: 'David', implicit: false });

    const printed = read(printedMarkerPath(dir));
    const sent = read(sentMarkerPath(dir));
    assert.equal(printed.by, 'Jirka', 'the printer printed it');
    assert.equal(printed.byRole, 'printer');
    assert.equal(sent.by, 'David', 'and the operator posted it');
    assert.equal(sent.byRole, 'operator');
    assert.notEqual(printed.by, sent.by, 'which is the whole point: the two acts name two people');

    // The role is stored beside the name because the name can change tomorrow (R11); a renamed
    // account must not make its own old markers unattributable.
    assert.deepEqual(markerActor({ role: 'printer', username: 'Tiskárna u Nádraží' }), { by: 'Tiskárna u Nádraží', byRole: 'printer' });
    assert.deepEqual(markerActor({ role: 'printer', username: '   ' }), { by: 'printer', byRole: 'printer' }, 'a blank name falls back to the role');
    assert.deepEqual(markerActor({ role: 'nonsense', username: 'x' }), { by: 'x', byRole: 'operator' }, 'an unknown role is never silently a printer');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ungated local mode writes the implicit operator, exactly as the tool always did (KTD11)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-implicit-'));
  try {
    const dir = join(root, '1601');
    mkdirSync(dir, { recursive: true });

    // Nobody signs in locally, so there is no display name to record.
    markSent(dir, { role: 'operator', username: 'David', implicit: true });
    assert.deepEqual(readMarkerActor(sentMarkerPath(dir)), { by: 'operator', byRole: 'operator' });

    // And a caller with no identity at all — a CLI, a test, anything off the HTTP boundary.
    markPrinted(dir);
    assert.deepEqual(readMarkerActor(printedMarkerPath(dir)), { by: 'operator', byRole: 'operator' });
    assert.deepEqual(markerActor(null), { by: 'operator', byRole: 'operator' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a marker with no recognisable actor still reads, as nobody in particular', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-legacy-actor-'));
  try {
    const dir = join(root, '1602');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'marker.json');

    // The markers on the live disk today: written before roles existed, so `by` is the old constant
    // and there is no role at all. It must read, not throw — the board polls this every 2.5s.
    writeFileSync(path, JSON.stringify({ at: '2026-01-01T00:00:00.000Z', by: 'operator' }));
    assert.deepEqual(readMarkerActor(path), { by: 'operator', byRole: null }, 'a pre-roles marker names its person and no role');

    for (const contents of ['{not json', '{}', 'null', '[]', JSON.stringify({ at: 'x', by: '   ' })]) {
      writeFileSync(path, contents);
      assert.equal(readMarkerActor(path), null, `"${contents}" reads as nobody, without throwing`);
    }
    assert.equal(readMarkerActor(join(dir, 'nope.json')), null, 'and a marker that is not there is nobody either');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** An outbox-only order the review state will find: a manifest and one approved photo, plus a book. */
function outboxOrder(outbox, orderId) {
  const dir = join(outbox, orderId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${orderId} Final.pdf`), '%PDF-1.4\n');
  writeManifest(dir, setStatus(emptyManifest(orderId), 'clean', STATES.OK, 'ok'));
  return dir;
}

const SERVER_CONFIG = {
  generator: { baseUrl: 'https://example.test/gen/', mode: 'api' },
  builder: { baseUrl: 'https://example.test/builder' },
  paths: { inbox: './inbox', outbox: './outbox' },
  retentionDays: 30,
};

test('AE7 — the printed marker names Jirka and the dispatch marker names David, from their own sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-signed-'));
  const outbox = join(root, 'outbox');
  const dir = outboxOrder(outbox, '1700');
  const password = 'correct horse battery staple';
  const hash = await hashPassword(password, { logN: 14, r: 8, p: 1 });
  const { server } = createReviewServer({
    config: { ...SERVER_CONFIG, accounts: { dataDir: join(root, 'accounts') } },
    inboxRoot: join(root, 'inbox'),
    outboxRoot: outbox,
    memoryRoot: outbox,
    driver: { generate: async () => {} },
    authEnv: { [ROLE_ENV_VARS.operator]: hash, [ROLE_ENV_VARS.printer]: hash },
  });
  try {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const signIn = async (username) => {
      const res = await fetch(`${origin}${SIGN_IN_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      assert.equal(res.status, 200, `${username} signs in`);
      return String(res.headers.get('set-cookie')).split(';')[0];
    };
    const printer = await signIn('Jirka');
    const operator = await signIn('David');
    const act = (path, cookie) => fetch(origin + path, { method: 'POST', headers: { cookie } });

    assert.equal((await act('/api/1700/printed', printer)).status, 200);
    assert.equal((await act('/api/1700/sent', operator)).status, 200);

    assert.deepEqual(readMarkerActor(printedMarkerPath(dir)), { by: 'Jirka', byRole: 'printer' }, 'Jirka printed it');
    assert.deepEqual(readMarkerActor(sentMarkerPath(dir)), { by: 'David', byRole: 'operator' }, 'David posted it');
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('in ungated local mode the same route records the implicit operator', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-signed-local-'));
  const outbox = join(root, 'outbox');
  const dir = outboxOrder(outbox, '1701');
  const { server } = createReviewServer({
    config: SERVER_CONFIG,
    inboxRoot: join(root, 'inbox'),
    outboxRoot: outbox,
    memoryRoot: outbox,
    driver: { generate: async () => {} },
    authEnv: {}, // no role hashes at all: the desktop workflow, one implicit identity (KTD11)
  });
  try {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${origin}/api/1701/printed`, { method: 'POST' })).status, 200);
    assert.deepEqual(readMarkerActor(printedMarkerPath(dir)), { by: 'operator', byRole: 'operator' });
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Jirka's print queue (R10, U12) ----------------------------------------

test('the print queue is the books that are built and not yet printed, and nothing else', () => {
  const ready = order('1800', summary({ total: 1, eligible: 1, ready: true }));
  const printed = order('1801', summary({ total: 1, eligible: 1, ready: true }));
  const dispatched = order('1802', summary({ total: 1, eligible: 1, ready: true }));
  const held = heldOrder('1803', 'Komu: x');
  const noBook = order('1804', summary({ total: 1, eligible: 1, ready: true })); // approved, no PDF yet
  const flagged = order('1805', summary({ total: 2, eligible: 1, held: 1 })); // a photo still awaits a verdict

  const built = new Set(['1800', '1801', '1802', '1803', '1805']);
  const board = buildBoard([ready, printed, dispatched, held, noBook, flagged], {
    pdfBuilt: (o) => built.has(o.orderId),
    printed: (o) => o.orderId === '1801' || o.orderId === '1802',
    sent: (o) => o.orderId === '1802',
  });

  assert.deepEqual(board.printQueue.map((o) => o.orderId), ['1800'], 'only the built, unprinted book');
  assert.equal(board.printQueue[0].status, ORDER_BOARD_STATES.READY_TO_PRINT);
  // Spelled out, because each exclusion is a different reason a book must not go to the press.
  const excluded = board.orders.filter((o) => !board.printQueue.includes(o)).map((o) => o.orderId);
  assert.deepEqual(excluded, ['1801', '1802', '1803', '1804', '1805'], 'printed, dispatched, held, no book yet, and flagged');

  // printQueue is pure over board entries, so the derivation can be checked on its own.
  assert.deepEqual(printQueue(board.orders).map((o) => o.orderId), ['1800']);
});

test('the press queue runs newest first, without disturbing the board it came from', () => {
  const waiting = ['1560', '1563-1', '1563-5', '1602'].map((id) => order(id, summary({ total: 1, eligible: 1, ready: true })));
  const board = buildBoard(waiting, { pdfBuilt: () => true, printed: () => false, sent: () => false });

  assert.deepEqual(board.printQueue.map((o) => o.orderId), ['1602', '1563-5', '1563-1', '1560']);
  // The board stays oldest-first — the queue sorts the copy `filter` handed it, not the board.
  assert.deepEqual(board.orders.map((o) => o.orderId), ['1560', '1563-1', '1563-5', '1602']);
});

test('marking an order printed takes it out of the queue', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-queue-'));
  try {
    const outbox = join(root, 'outbox');
    const dir = join(outbox, '1810');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '1810 Final.pdf'), '%PDF-1.4\n');

    const fakeState = () => [order('1810', summary({ total: 1, eligible: 1, ready: true }), { orderDir: dir })];
    const queue = () => studioBoard({ inboxRoot: null, outboxRoot: outbox, state: fakeState }).printQueue.map((o) => o.orderId);
    assert.deepEqual(queue(), ['1810'], 'the book is on the press queue');

    markPrinted(dir, { role: 'printer', username: 'Jirka' });
    assert.deepEqual(queue(), [], 'and leaves it the moment it is printed');

    unmarkPrinted(dir);
    assert.deepEqual(queue(), ['1810'], 'an undone mis-click puts it back');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The page's own source, once, for the tests that RUN pieces of it. */
const PAGE = readFileSync(new URL('../src/ui/static/dashboard.html', import.meta.url), 'utf8');

/** Lift one `const <name>=<arrow>;` out of the page and make it callable, with its free variables
 *  passed in. This is how a page-side rule gets asserted on its BEHAVIOUR rather than on the shape
 *  of its source: a regex saying the line looks right passes just as happily when the rule is wrong,
 *  and a test that only reads text is the reason the landing rule below was never actually run. */
function pageFunction(name, deps) {
  const src = new RegExp(`const ${name}=(\\([^)]*\\)=>[^;]+);`).exec(PAGE);
  assert.ok(src, `${name} is still defined in dashboard.html as a one-line arrow this test can lift out`);
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func — lifting the shipped source is the entire point
  return new Function(...names, `return (${src[1]});`)(...names.map((k) => deps[k]));
}

// A redeploy drops every session, because the session table lives in the server process. The board
// then polls, gets 401, and used to `return` on it exactly as it does for a dropped connection —
// leaving the full studio on screen with nothing in it. That screen cost an afternoon to a report of
// "all my orders are gone and intake is broken", when the orders were all present and the autopilot
// was mid-run on a new one. Lifted out and RUN, because the whole bug was a status nobody looked at.
test('a poll that comes back signed-out goes to the sign-in page, not a silent empty board', () => {
  const bounce = (status) => {
    const location = { href: '/' };
    const handled = pageFunction('signedOut', { location })({ status });
    return { handled, href: location.href };
  };

  assert.deepEqual(bounce(401), { handled: true, href: '/login' }, 'a dead session lands on the sign-in page');
  assert.deepEqual(bounce(200), { handled: false, href: '/' }, 'a good response is left alone');
  // Not every non-2xx is a dead session: 403 is the printer reaching an operator-only route, and 503
  // is the server restarting. Bouncing either would throw someone off a working page.
  assert.deepEqual(bounce(403), { handled: false, href: '/' }, 'a role refusal is not a sign-out');
  assert.deepEqual(bounce(503), { handled: false, href: '/' }, 'nor is a server blip');

  // And it is actually wired into the pollers — the rule above is worth nothing unwired.
  assert.match(PAGE, /fetch\("\/api\/studio"\);if\(signedOut\(res\)\|\|!res\.ok\)return;/, 'the board poller checks it');
  assert.match(PAGE, /fetch\("\/api\/mail"\);if\(signedOut\(r\)\|\|!r\.ok\)return;/, 'and so does the mail poller');
  const REVIEW = readFileSync(new URL('../src/ui/static/index.html', import.meta.url), 'utf8');
  assert.match(REVIEW, /if \(res\.status === 401\) \{ location\.href = '\/login'; return; \}/, 'and the review grid');
});

// The homepage's paid-vs-organic block exists to answer one question honestly. These lift its rules
// out of the shipped page and RUN them, because the failure mode is a plausible-looking number
// rather than a broken page — and a regex over the source would keep passing while the arithmetic
// silently said the ads were free.
test('missing spend is not zero: the block says it does not know rather than inventing a return', () => {
  const state = (spend) => pageFunction('spendState', {})(spend);
  assert.equal(state(null), 'missing', 'nobody has entered a figure');
  assert.equal(state({ amount: 0 }), 'zero', 'and a genuine zero is a different answer');
  assert.equal(state({ amount: 6200 }), 'known');

  // The arithmetic behind it: dividing by a spend of zero must not produce a return at all.
  const roas = (revenue, amount) => pageFunction('roasOf', {})(revenue, amount);
  assert.equal(roas(14779, 6200), 2.4, 'revenue over spend, to one decimal');
  assert.equal(roas(14779, 0), null, 'a zero spend yields no return — not Infinity, which renders as "the ads were free"');
  assert.equal(roas(0, 6200), 0, 'and spending with nothing to show for it is a real zero');
});

test('cost per order needs orders, and says nothing when there are none', () => {
  const per = (amount, orders) => pageFunction('perOrder', {})(amount, orders);
  assert.equal(per(6200, 21), 295);
  assert.equal(per(6200, 0), null, 'no orders means no cost per order, not a division by zero');
});

test('the block is operator-only in the markup, not merely by the route it calls', () => {
  // /api/studio answers both roles and the identity poll is what reveals these sections, so the
  // section must ship hidden — otherwise a printer paints the shop's revenue for one frame.
  const section = /<section id="channelsSection"([^>]*)>/.exec(PAGE);
  assert.ok(section, 'the block is still a section this test can find');
  assert.match(section[1], /data-operator/, 'carries data-operator');
  assert.match(section[1], /\bhidden\b/, 'and ships hidden, like the economics block beside it');
});

test('the recent-orders list names an unattributed order rather than leaving a blank cell', () => {
  // "bez zdroje" is the truth for about a fifth of orders. An empty cell would read as a rendering
  // fault, and the operator would go looking for a bug instead of accepting the answer.
  const label = (a) => pageFunction('sourceLabel', {})(a);
  assert.equal(label(null), 'bez zdroje', 'no attribution at all');
  assert.equal(label({ channel: 'unknown', campaign: null }), 'bez zdroje', 'and an explicit unknown reads the same');
  assert.equal(label({ channel: 'paid', campaign: 'A+ sales - 3-2026' }), 'placené · A+ sales - 3-2026');
  assert.equal(label({ channel: 'organic', campaign: null }), 'organické', 'no campaign, no separator dangling');
  assert.equal(label({ channel: 'direct', campaign: null }), 'direct');
});

test('the recent list is operator-only in the markup, which matters more here than for the money block', () => {
  // /api/studio answers BOTH roles, so unlike the revenue block this one is not protected by its
  // route at all — without the attribute a printer session paints real customer order rows.
  const section = /<section id="recentSection"([^>]*)>/.exec(PAGE);
  assert.ok(section, 'the list is still a section this test can find');
  assert.match(section[1], /data-operator/);
  assert.match(section[1], /\bhidden\b/);
});

test('a printer session lands on the print queue; the operator lands on the board', () => {
  // The page's real landing rule, LIFTED OUT AND RUN — not matched against a regex. The rule decides
  // the first screen each person sees, and "the source contains this string" would keep passing if
  // the two branches were swapped tomorrow.
  const landing = (hash, operator, view = 'settings') =>
    pageFunction('landingView', { location: { hash }, currentView: () => view, isOperator: () => operator })();

  assert.equal(landing('', false), 'queue', 'a printer with no fragment lands on the print queue');
  assert.equal(landing('', true), 'home', 'the operator lands on the board');
  assert.equal(landing('#settings', true, 'settings'), 'settings', 'an explicit fragment still wins for the operator');
  assert.equal(landing('#queue', false, 'queue'), 'queue', 'and for the printer');

  // A fragment the printer may not have is refused by the guard beside it, not by the landing rule —
  // so that guard is run here too, with the operator-only list the page actually ships.
  const OPERATOR_VIEWS = JSON.parse(/const OPERATOR_VIEWS=(\[[^\]]*\]);/.exec(PAGE)[1]);
  const allowed = (view, operator) =>
    pageFunction('viewAllowed', { isOperator: () => operator, OPERATOR_VIEWS })(view);
  assert.equal(allowed('settings', false), false, '#settings typed into the address bar is refused for the printer');
  assert.equal(allowed('mail', false), false, 'and so is the mailbox');
  assert.equal(allowed('queue', false), true, 'while the queue is his');
  assert.equal(allowed('settings', true), true, 'and the operator reaches everything');

  const page = PAGE;
  assert.match(page, /fetchStudio\(\)\.finally\(\(\)=>go\(landingView\(\)\)\)/, 'and the first paint goes through it, after the identity is known');
  assert.match(page, /const views=\[[^\]]*"queue"[^\]]*\]/, 'the queue is a real view the resolver knows');
  assert.match(page, /queue:\{t:"Tisková fronta"/, 'with an operator-facing title');
  // Two controls per row and no more: the book, and the mark that it was printed.
  const view = page.slice(page.indexOf('function renderQueue('), page.indexOf('// Waiting-since'));
  assert.match(view, /\/api\/\$\{esc\(o\.orderId\)\}\/pdf/, 'the row offers the download');
  assert.match(view, /act-printed/, 'and the printed action');
  for (const forbidden of ['act-sent', 'act-unsent', 'act-delete', 'act-generate', 'act-buildpdf']) {
    assert.ok(!view.includes(forbidden), `the queue row does not offer ${forbidden}`);
  }
});

test('the board offers a printer nothing the server would refuse him', () => {
  // Reflection, never enforcement — the server refuses these routes for a printer whatever the page
  // renders (see test/reviewServer.test.js). But a button whose only possible outcome is a 403 toast
  // is a bug in its own right: it tells Jirka the studio is broken, when in fact it is working.
  //
  // Enumerated rather than spot-checked, because the one that was wrong (Smazat) sat three lines
  // under a comment claiming this was already handled.
  const row = PAGE.slice(PAGE.indexOf('function orderRow('), PAGE.indexOf('function renderHome('));
  const lineWith = (needle) => {
    const at = row.indexOf(needle);
    assert.ok(at >= 0, `the row still renders ${needle}`);
    return row.slice(row.lastIndexOf('\n', at) + 1, row.indexOf('\n', at));
  };

  // Every action whose route is operator-only in ROUTE_POLICY.
  for (const cls of ['act-sent', 'act-unsent', 'act-delete']) {
    assert.match(lineWith(cls), /isOperator\(\)/, `${cls} is only rendered for the operator — its route is operator-only`);
  }
  // And the printer's own actions are NOT gated, or the board would be useless to him.
  for (const cls of ['act-printed', 'act-unprinted']) {
    assert.ok(!lineWith(cls).includes('isOperator()'), `${cls} stays available to the printer — printing is his job`);
  }

  // The home card's "continue" CTA used to ask this same question a second time — its most-actionable
  // state was `printed`, whose only action is dispatch, so a printer's first screen offered him a 403.
  // The card is gone, and with it that second surface. The row actions above are now the only place
  // the board offers an action, which is one rule to keep right instead of two.
  assert.ok(!PAGE.includes('const priority=isOperator()'), 'the work card and its role-aware CTA are gone');
});

test('the purge panel\'s two numbers describe the set they are attached to', () => {
  // `eligibility` counts the WHOLE eligible set; the table above it lists this run\'s capped batch.
  // Attached to the batch sentence, the panel read "25 objednávek — z toho 3 + 97", which is not a
  // rounding error but two different sets in one sentence. The CLI has always named the eligible
  // total ("Eligible: N — X dispatched, Y backfilled"); the panel says it the same way now.
  const panel = PAGE.slice(PAGE.indexOf('function renderPurge('), PAGE.indexOf('async function confirmPurge('));
  const lineWith = (needle) => {
    const at = panel.indexOf(needle);
    assert.ok(at >= 0, `the panel still renders ${needle}`);
    return panel.slice(panel.lastIndexOf('\n', at) + 1, panel.indexOf('\n', at));
  };

  const origins = lineWith('${e.dispatched}');
  assert.match(origins, /\$\{e\.total\}/, 'the backfilled/dispatched split is labelled with the eligible TOTAL it counts');
  assert.ok(!origins.includes('rows.length'), 'and not with the size of this run\'s batch');

  const batch = lineWith('${purgeMb(d.bytes)}');
  assert.match(batch, /rows\.length/, 'while the "would delete" sentence describes the batch, which is what the table lists');
  assert.ok(!batch.includes('e.total'), 'the two sentences do not share a number between two different sets');

  // The autopilot files the confirmation clears are named too — the panel is meant to be exactly
  // what the button does.
  assert.match(panel, /autopilotFiles/, 'the night report + handled-set are listed before they are deleted');
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

// ---- one purchase, several books --------------------------------------------

/** One book of a purchase, review-state shaped. */
const bookOf = (orderId, purchaseId, position, of, s = summary(), extra = {}) =>
  order(orderId, s, { purchase: { orderId: purchaseId, position, of }, copies: 1, ...extra });

test('a lone book carries no linkage and no copy count, so its row is unchanged', () => {
  const [entry] = buildBoard([order('1500', summary({ total: 2, eligible: 2, ready: true }))]).orders;
  assert.equal(entry.purchase, null, 'nothing to link it to');
  assert.equal(entry.copies, null, 'one copy is the ordinary case and says nothing');
  assert.equal(entry.siblingPending, null);
});

test('the books of one purchase each carry their position in it', () => {
  const { orders } = buildBoard([
    bookOf('1234-1', '1234', 1, 2, summary({ total: 2, eligible: 2, ready: true })),
    bookOf('1234-2', '1234', 2, 2, summary({ total: 2, eligible: 2, ready: true })),
  ]);
  assert.deepEqual(orders.map((o) => o.purchase.position), [1, 2]);
  assert.deepEqual(orders.map((o) => o.purchase.of), [2, 2]);
  assert.deepEqual(orders.map((o) => o.orderId), ['1234-1', '1234-2'], 'and they sort adjacently');
});

test('a copy count above one is surfaced; quantity 1 stays silent', () => {
  const { orders } = buildBoard([
    order('1500', summary(), { copies: 3 }),
    order('1501', summary(), { copies: 1 }),
  ]);
  assert.equal(orders[0].copies, 3, 'the operator has to print this one three times');
  assert.equal(orders[1].copies, null);
});

test('a book whose sibling is still held reports it, so half a parcel is not dispatched', () => {
  const { orders } = buildBoard(
    [
      bookOf('1234-1', '1234', 1, 2, summary({ total: 2, eligible: 2, ready: true })),
      bookOf('1234-2', '1234', 2, 2, summary(), {
        intake: { verdict: 'hold', override: false, findings: [{ check: 'count', verdict: 'hold' }] },
      }),
    ],
    { pdfBuilt: (o) => o.orderId === '1234-1' },
  );
  const [first, second] = orders;
  assert.equal(first.status, ORDER_BOARD_STATES.READY_TO_PRINT);
  assert.equal(second.status, ORDER_BOARD_STATES.HELD);
  assert.deepEqual(
    first.siblingPending,
    [{ orderId: '1234-2', position: 2, status: ORDER_BOARD_STATES.HELD }],
    'the finished book warns that its parcel is not complete',
  );
  // Under the old lifecycle this read null: a built book was "ready to leave", because the terminal
  // act was the print. Now the terminal act is the post, so a book that is only built is still
  // unfinished and each book correctly names the other. Neither can go anywhere on its own.
  assert.deepEqual(second.siblingPending, [
    { orderId: '1234-1', position: 1, status: ORDER_BOARD_STATES.READY_TO_PRINT },
  ]);
});

test('once both books are printed, neither warns — the parcel is whole', () => {
  const { orders } = buildBoard(
    [
      bookOf('1234-1', '1234', 1, 2, summary({ total: 1, eligible: 1, ready: true })),
      bookOf('1234-2', '1234', 2, 2, summary({ total: 1, eligible: 1, ready: true })),
    ],
    { pdfBuilt: () => true, printed: () => true },
  );
  assert.deepEqual(orders.map((o) => o.siblingPending), [null, null]);
});

test('a built-but-unprinted sibling still holds the parcel back', () => {
  // The case the warning exists for, and the one the lifecycle re-cut nearly lost: book 1 is off the
  // press and about to be posted, book 2 is only a PDF. Posting now sends half a parcel.
  const { orders } = buildBoard(
    [
      bookOf('1234-1', '1234', 1, 2, summary({ total: 1, eligible: 1, ready: true })),
      bookOf('1234-2', '1234', 2, 2, summary({ total: 1, eligible: 1, ready: true })),
    ],
    { pdfBuilt: () => true, printed: (o) => o.orderId === '1234-1' },
  );
  const first = orders.find((o) => o.orderId === '1234-1');
  assert.equal(first.status, ORDER_BOARD_STATES.PRINTED);
  assert.deepEqual(first.siblingPending, [
    { orderId: '1234-2', position: 2, status: ORDER_BOARD_STATES.READY_TO_PRINT },
  ]);
});

test('a book already sent does not hold its sibling back', () => {
  const { orders } = buildBoard(
    [
      bookOf('1234-1', '1234', 1, 2, summary({ total: 1, eligible: 1, ready: true })),
      bookOf('1234-2', '1234', 2, 2, summary({ total: 1, eligible: 1, ready: true })),
    ],
    // `sent`, not the retired `delivered` — buildBoard ignores an unknown option, so the old spelling
    // left book 1 merely built and this passed without ever exercising a dispatched sibling.
    { pdfBuilt: () => true, printed: () => true, sent: (o) => o.orderId === '1234-1' },
  );
  const second = orders.find((o) => o.orderId === '1234-2');
  assert.equal(second.siblingPending, null, 'a sent book has left already — it is not pending');
});

test('books of different purchases never link to each other', () => {
  const { orders } = buildBoard([
    bookOf('1234-1', '1234', 1, 2, summary(), {}),
    bookOf('1234-2', '1234', 2, 2, summary({ total: 1, eligible: 1, ready: true })),
    bookOf('1300-1', '1300', 1, 2, summary({ total: 1, eligible: 1, ready: true })),
  ]);
  const from1300 = orders.find((o) => o.orderId === '1300-1');
  assert.equal(from1300.siblingPending, null, "1234's unfinished book is not 1300's problem");
});
