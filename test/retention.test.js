import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { inspectOutbox, purgeOriginals, inspectAutopilotData, purgeAutopilotData, PURGE_BATCH_CAP, STALLED_WINDOW_MULTIPLE } from '../src/retention.js';
import { markSent, unmarkPrinted, unmarkSent, readSentMarker } from '../src/studio.js';
import { parseArgs, report } from '../src/purge.js';
import { createReviewServer } from '../src/ui/server.js';
import { hashPassword, ROLE_ENV_VARS } from '../src/auth/credentials.js';
import { SIGN_IN_PATH } from '../src/auth/sessions.js';
import { STATES, emptyManifest, setStatus, writeManifest, readManifest, manifestPath } from '../src/manifest.js';

const DAY = 24 * 60 * 60 * 1000;

// A frozen "today" for every test that can hand the code under test its own clock — retention.js
// takes `now` on all four entry points, so those tests are genuinely time-independent.
//
// The catch, and the reason this file rotted: the ROUTE tests reach the same logic over HTTP, where
// the server uses the real Date.now(). Ageing their fixtures against this frozen date meant an
// order seeded as "sent 2 days ago" got an mtime of 8 July 2026 — which stopped being 2 days ago on
// 9 July and crossed the 30-day retention line on 7 August, failing a test that had been correct
// for a month. The fixtures had a shelf life, and the comment here used to claim the opposite.
//
// So `age` takes the clock its caller is measured against: NOW for the frozen tests, the real one
// for the route tests, which pass `ref: Date.now()`. Both are then internally consistent, and
// neither expires.
const NOW = Date.UTC(2026, 6, 10);

/** The clock the ROUTE tests are measured against: the server calls Date.now() and cannot be handed
 *  another. Read once per run so every fixture in a test agrees with itself. */
const REAL = Date.now();

const age = (path, ms, ref = NOW) => {
  const t = (ref - ms) / 1000;
  utimesSync(path, t, t);
};

/** An order folder holding two photos, their line art, a manifest, (optionally) a printed book, and
 *  the two lifecycle markers.
 *
 *  `sent` is the one that matters: the purge gate is the DISPATCH marker now (R18), and its mtime is
 *  the retention clock. `printed` still gets written by default because a real dispatched order was
 *  printed first — set `sent: false` for a book still on the operator's desk. */
function order(
  outbox,
  orderId,
  { pdf = true, printed = true, sent = true, sentDaysAgo = 100, printedDaysAgo = sentDaysAgo, backfilled = false, staleDecision = false, photos = ['a', 'b'], ref = NOW } = {},
) {
  const dir = join(outbox, orderId);
  mkdirSync(dir, { recursive: true });
  const manifest = emptyManifest(orderId);
  for (const base of photos) {
    writeFileSync(join(dir, `${base}.jpg`), 'a photograph of a child');
    writeFileSync(join(dir, `${base}.svg`), '<svg/>');
    writeFileSync(join(dir, `${base}_bw.png`), 'line art');
    setStatus(manifest, base, STATES.OK, 'ok');
  }
  writeManifest(dir, manifest);
  age(manifestPath(dir), sentDaysAgo * DAY + (staleDecision ? -1 * DAY : 1 * DAY), ref);

  if (pdf) {
    const pdfPath = join(dir, `${orderId} Final.pdf`);
    writeFileSync(pdfPath, '%PDF-1.4');
    age(pdfPath, sentDaysAgo * DAY, ref);
  }
  if (printed) {
    const printedPath = join(dir, 'printed.json');
    writeFileSync(printedPath, JSON.stringify({ at: new Date(ref - printedDaysAgo * DAY).toISOString(), by: 'Jirka', byRole: 'printer' }));
    age(printedPath, printedDaysAgo * DAY, ref);
  }
  if (sent) {
    const sentPath = join(dir, 'sent.json');
    writeFileSync(sentPath, JSON.stringify(backfilled ? { at: new Date(ref - sentDaysAgo * DAY).toISOString(), backfilled: true } : { at: new Date(ref - sentDaysAgo * DAY).toISOString(), by: 'David', byRole: 'operator' }));
    age(sentPath, sentDaysAgo * DAY, ref); // the dispatch marker's mtime IS the retention clock
  }
  return dir;
}

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-purge-'));
  const outbox = join(root, 'outbox');
  mkdirSync(outbox, { recursive: true });
  return { root, outbox, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

const jpgs = (dir) => readdirSync(dir).filter((f) => f.endsWith('.jpg'));

test('purging a captured inspection does not delete an order added later', () => {
  const f = fixture();
  try {
    order(f.outbox, '1400', { sentDaysAgo: 100 });
    const inspected = inspectOutbox({ outboxRoot: f.outbox, days: 30, now: NOW });
    const later = order(f.outbox, '1401', { sentDaysAgo: 100 });
    purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false, inspected });
    assert.equal(jpgs(later).length, 2);
  } finally { f.cleanup(); }
});

test('a dispatched book older than the retention window gives up its photographs', () => {
  const f = fixture();
  try {
    const dir = order(f.outbox, '1400', { sentDaysAgo: 100 });
    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });

    assert.equal(result.photos, 2);
    assert.deepEqual(jpgs(dir), [], 'the photographs are gone');
    assert.ok(existsSync(join(dir, 'a.svg')), 'the drawing stays — it is not a photograph');
    assert.ok(existsSync(join(dir, 'a_bw.png')));
    assert.ok(existsSync(join(dir, '1400 Final.pdf')), 'and so does the book');
    assert.ok(existsSync(manifestPath(dir)));
    assert.match(readManifest(dir).photosPurgedAt, /^2026-07-10T/, 'the manifest records when');
  } finally {
    f.cleanup();
  }
});

test('a dry run is the default, and it deletes nothing', () => {
  const f = fixture();
  try {
    const dir = order(f.outbox, '1400', { sentDaysAgo: 100 });
    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW });

    assert.equal(result.dryRun, true);
    assert.equal(result.photos, 2, 'it still says what it would take');
    assert.equal(jpgs(dir).length, 2, 'and takes none of it');
    assert.equal(readManifest(dir).photosPurgedAt, undefined);
  } finally {
    f.cleanup();
  }
});

test('a book dispatched inside the window is left alone', () => {
  const f = fixture();
  try {
    const dir = order(f.outbox, '1400', { sentDaysAgo: 10 });
    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });

    assert.equal(result.photos, 0);
    assert.equal(jpgs(dir).length, 2);
    assert.match(result.skipped[0].skip, /dispatched 10 days ago, keeping for 30/);
  } finally {
    f.cleanup();
  }
});

test('AE12 — an order printed but not dispatched keeps its photographs, however finished the book looks', () => {
  const f = fixture();
  try {
    // The book is built and Jirka has printed it. It is on somebody's desk, not in the post: the
    // customer has not had it, and it may yet need reprinting from these very photographs.
    const dir = order(f.outbox, '1400', { printed: true, sent: false, printedDaysAgo: 10 });
    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });

    assert.equal(result.photos, 0, 'the print is not what starts the clock any more');
    assert.equal(jpgs(dir).length, 2);
    assert.match(result.skipped[0].skip, /not dispatched to the customer yet/);
    assert.equal(result.skipped[0].ageDays, null, 'and no age is reported, because no clock has started');
  } finally {
    f.cleanup();
  }
});

test('an order whose book was never finished is never touched, however old', () => {
  const f = fixture();
  try {
    const dir = order(f.outbox, '1400', { pdf: false, printed: false, sent: false, sentDaysAgo: 900 });
    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });

    assert.equal(jpgs(dir).length, 2, 'its photographs are the only way to print it');
    assert.match(result.skipped[0].skip, /not dispatched to the customer yet/);
  } finally {
    f.cleanup();
  }
});

test('an order carrying only the RETIRED delivery marker is not dispatched and is never purged (R16, KTD6)', () => {
  const f = fixture();
  try {
    // `delivered.json` meant "handed to Jirka" — a state that now sits BEFORE printing. Reading it
    // as a dispatch would purge the photographs of a book still waiting for the press.
    const dir = order(f.outbox, '1400', { printed: false, sent: false, sentDaysAgo: 900 });
    writeFileSync(join(dir, 'delivered.json'), JSON.stringify({ at: '2024-01-01T00:00:00.000Z' }));
    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });

    assert.equal(jpgs(dir).length, 2, 'the retired marker buys nothing');
    assert.match(result.skipped[0].skip, /not dispatched to the customer yet/);
  } finally {
    f.cleanup();
  }
});

test('an order decided after its book was built keeps its photographs', () => {
  const f = fixture();
  try {
    // The operator rejected a photo last week; the PDF on disk is not the book they want.
    const dir = order(f.outbox, '1400', { sentDaysAgo: 100, staleDecision: true });
    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });

    assert.equal(jpgs(dir).length, 2, 'it has still to be reprinted, and reprinting needs them');
    assert.match(result.skipped[0].skip, /decision changed after the book was built/);
  } finally {
    f.cleanup();
  }
});

test('a BACKFILLED dispatch marker is honoured on its original date, and counted apart from a real dispatch (R17, KTD7)', () => {
  const f = fixture();
  try {
    // The migration wrote this from printed.json to preserve the eligibility date the order already
    // had. Retention honours it — the date is the truth about when the book left the studio — but
    // the report has to say which orders got there that way, or a big first batch reads as a bug.
    const old = order(f.outbox, '1400', { sentDaysAgo: 100, backfilled: true });
    order(f.outbox, '1401', { sentDaysAgo: 100 }); // dispatched by hand
    order(f.outbox, '1402', { sentDaysAgo: 5, backfilled: true }); // backfilled but still inside the window

    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW });
    assert.deepEqual(result.orders.map((o) => o.orderId), ['1400', '1401'], 'a backfilled marker is eligible like any other');
    assert.equal(result.orders[0].ageDays, 100, 'measured from the backfilled marker\'s own mtime, not from today');
    assert.deepEqual(
      result.eligibility,
      { total: 2, backfilled: 1, dispatched: 1 },
      'and the two origins are counted separately for the operator to read',
    );

    purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });
    assert.deepEqual(jpgs(old), [], 'the historical order is purged on the schedule it always had');
    assert.equal(jpgs(join(f.outbox, '1402')).length, 2, 'a backfilled marker inside the window still protects its photos');
  } finally {
    f.cleanup();
  }
});

// ---- the two ways the clock and the gate were losable (the markers move under retention) --------

test('confirming a BACKFILLED dispatch keeps the date the migration preserved — the backlog does not restart at zero', () => {
  const f = fixture();
  try {
    // The whole of R17 in one sequence. The migration dated this marker from the print, 100 days ago.
    // The board shows the order as `printed` with ONE button — "Označit odeslané" — so working the
    // historical backlog means passing every one of those orders through markSent. A plain write
    // stamps today's mtime, retention reads the mtime, and the entire backlog's retention window
    // starts again from zero: the migration undone by the operator doing what the board asked.
    const dir = order(f.outbox, '1400', { sentDaysAgo: 100, backfilled: true });
    const before = statSync(join(dir, 'sent.json')).mtimeMs;

    markSent(dir, { role: 'operator', username: 'David', implicit: false });

    const marker = JSON.parse(readFileSync(join(dir, 'sent.json'), 'utf8'));
    assert.equal(marker.by, 'David', 'the confirmation records who confirmed it');
    assert.equal(marker.byRole, 'operator');
    assert.equal(marker.backfilled, undefined, 'and it is no longer a backfill — somebody has now said so');
    assert.equal(readSentMarker(dir).backfilled, false, 'so the board treats the order as dispatched and retires it');

    assert.equal(statSync(join(dir, 'sent.json')).mtimeMs, before, 'but the FILE keeps its date: the book left when it left');
    const [inspected] = inspectOutbox({ outboxRoot: f.outbox, days: 30, now: NOW });
    assert.equal(inspected.ageDays, 100, 'so retention still measures 100 days, not 0');
    assert.equal(inspected.skip, null, 'and the order is eligible today rather than in another 100 days');
    assert.equal(inspected.backfilled, false, 'counted as a real dispatch now, which it is');
  } finally {
    f.cleanup();
  }
});

test('an ordinary dispatch confirmed again IS re-dated — only a backfill carries its old clock', () => {
  const f = fixture();
  try {
    // The other half of the rule, so the exception cannot quietly become "markSent never re-dates".
    // Re-confirming a real dispatch is the operator correcting the record, and the new date is right.
    const dir = order(f.outbox, '1400', { sentDaysAgo: 100 });
    markSent(dir, { role: 'operator', username: 'David', implicit: false });

    // A minute past the write, so a filesystem that rounds mtimes up cannot make "just now" negative.
    const [inspected] = inspectOutbox({ outboxRoot: f.outbox, days: 30, now: Date.now() + 60_000 });
    assert.equal(inspected.ageDays, 0, 'dispatched today, because that is when it was confirmed');
    assert.match(inspected.skip, /keeping for 30/, 'and the window starts now');
  } finally {
    f.cleanup();
  }
});

test('UNDOING A PRINT stops the dispatch marker counting: the photographs of a book back in the queue are not purged', () => {
  const f = fixture();
  try {
    // The migration gives every historically-printed order a backfilled sent.json dated months ago.
    // "Vrátit" on a bad print (both roles can reach it) removes ONLY printed.json — and then the
    // board correctly re-queues the book for Jirka while a gate that asked `existsSync(sent.json)`
    // alone would call the same order eligible and delete the photographs it will be reprinted from.
    const dir = order(f.outbox, '1400', { sentDaysAgo: 100, backfilled: true });
    assert.equal(inspectOutbox({ outboxRoot: f.outbox, days: 30, now: NOW })[0].skip, null, 'eligible while it is printed AND dispatched');

    unmarkPrinted(dir);

    const [inspected] = inspectOutbox({ outboxRoot: f.outbox, days: 30, now: NOW });
    assert.match(inspected.skip, /dispatched but not printed/, 'the pair of markers is contradictory, so it is not a dispatch');
    assert.equal(inspected.ageDays, null, 'and no clock is reported for a dispatch that cannot have happened');

    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });
    assert.deepEqual(result.orders, [], 'a confirmed purge takes nothing');
    assert.equal(result.eligibility.total, 0);
    assert.equal(jpgs(dir).length, 2, 'the customer\'s photographs are still there for the reprint');
  } finally {
    f.cleanup();
  }
});

test('a hand-deleted printed marker is the same invariant, and re-printing restores eligibility', () => {
  const f = fixture();
  try {
    // The invariant lives in inspectOutbox rather than in unmarkPrinted precisely so it also covers
    // the routes nobody wrote: a marker deleted by hand on the mounted disk, a half-restored backup.
    const dir = order(f.outbox, '1400', { sentDaysAgo: 100 });
    rmSync(join(dir, 'printed.json'), { force: true });
    assert.match(inspectOutbox({ outboxRoot: f.outbox, days: 30, now: NOW })[0].skip, /dispatched but not printed/);

    // And it is not a trap door: put the print back and the order is eligible again on its own date.
    writeFileSync(join(dir, 'printed.json'), JSON.stringify({ at: '2026-03-01T00:00:00.000Z', by: 'Jirka', byRole: 'printer' }));
    const [again] = inspectOutbox({ outboxRoot: f.outbox, days: 30, now: NOW });
    assert.equal(again.skip, null, 'printed and dispatched again');
    assert.equal(again.ageDays, 100, 'on the dispatch date it always had');
  } finally {
    f.cleanup();
  }
});

test('undoing the DISPATCH still leaves a printed book alone — and the stalled backstop still sees it', () => {
  const f = fixture();
  try {
    const dir = order(f.outbox, '1400', { sentDaysAgo: 400, printedDaysAgo: 400 });
    unmarkSent(dir);

    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });
    assert.equal(jpgs(dir).length, 2, 'no dispatch marker, no purge');
    assert.deepEqual(result.stalled.map((o) => o.orderId), ['1400'], 'and it is surfaced as printed-but-never-dispatched');
  } finally {
    f.cleanup();
  }
});

test('THE CAP: one confirmed run deletes at most `cap` orders and leaves the rest for the next one', () => {
  const f = fixture();
  try {
    // The P0 this exists for: purge has never run on the hosted box, and the backfill gave every
    // order ever printed a dispatch date in the past. Without a cap the first run offers the lot.
    for (let n = 0; n < 5; n++) order(f.outbox, `${1400 + n}`, { sentDaysAgo: 100, backfilled: true });

    const dry = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, cap: 2 });
    assert.deepEqual(dry.orders.map((o) => o.orderId), ['1400', '1401'], 'the report shows the batch that would go');
    assert.deepEqual(dry.deferred.map((o) => o.orderId), ['1402', '1403', '1404'], 'and names what it is leaving');
    assert.equal(dry.eligibility.total, 5, 'the eligible count is the whole set, not just the batch');
    assert.equal(dry.photos, 4, 'the byte/photo totals describe THIS run, not the whole set');

    const run = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, cap: 2, dryRun: false });
    assert.equal(run.orders.length, 2);
    assert.deepEqual(jpgs(join(f.outbox, '1400')), [], 'the first two orders lost their photographs');
    assert.deepEqual(jpgs(join(f.outbox, '1401')), []);
    assert.equal(jpgs(join(f.outbox, '1402')).length, 2, 'and everything past the cap is untouched');
    assert.equal(jpgs(join(f.outbox, '1404')).length, 2);

    // Run it again: the next batch comes up. Nothing is stranded by the cap.
    const second = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, cap: 2, dryRun: false });
    assert.deepEqual(second.orders.map((o) => o.orderId), ['1402', '1403'], 'a subsequent run takes the next batch');
    assert.equal(jpgs(join(f.outbox, '1404')).length, 2, 'and still stops at the cap');

    // The default is a real number, and `null` opts out for a caller that knows what it is doing.
    assert.equal(purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW }).cap, PURGE_BATCH_CAP);
    assert.equal(purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, cap: null }).deferred.length, 0);
    assert.throws(() => purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, cap: 0 }), TypeError);
  } finally {
    f.cleanup();
  }
});

test('THE BACKSTOP: an order printed and never dispatched is listed as stalled, with its age, and never deleted', () => {
  const f = fixture();
  try {
    // Cancelled, refunded, or simply forgotten. Eligibility now depends on an operator action that
    // may never come, so these keep their photographs forever unless somebody is told about them.
    const stalled = order(f.outbox, '1400', { printed: true, sent: false, printedDaysAgo: 200 });
    order(f.outbox, '1401', { printed: true, sent: false, printedDaysAgo: 10 }); // printed last week — not stalled yet
    order(f.outbox, '1402', { sentDaysAgo: 100 }); // ordinary, eligible

    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });
    assert.deepEqual(result.stalled.map((o) => o.orderId), ['1400'], 'only the one past days × the multiple');
    assert.equal(result.stalled[0].stalledDays, 200, 'reported with its age, so the operator can judge it');
    assert.match(result.stalled[0].skip, /never dispatched/);
    assert.deepEqual(result.orders.map((o) => o.orderId), ['1402'], 'a stalled order is NEVER in the delete list');
    assert.equal(jpgs(stalled).length, 2, 'and its photographs are still there after a confirmed run');

    // The threshold is a multiple of the window, so raising retentionDays moves it too.
    assert.equal(STALLED_WINDOW_MULTIPLE >= 1, true);
    const wider = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, stalledMultiple: 10 });
    assert.deepEqual(wider.stalled, [], 'at ten windows, 200 days is not yet stalled');
    assert.throws(() => inspectOutbox({ outboxRoot: f.outbox, days: 30, now: NOW, stalledMultiple: 0 }), TypeError);
  } finally {
    f.cleanup();
  }
});

test('purging twice is a no-op, not an error', () => {
  const f = fixture();
  try {
    order(f.outbox, '1400', { sentDaysAgo: 100 });
    purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });
    const again = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });

    assert.equal(again.photos, 0);
    assert.match(again.skipped[0].skip, /already gone/);
  } finally {
    f.cleanup();
  }
});

test('purging does not make the printed book look stale', () => {
  const f = fixture();
  try {
    const dir = order(f.outbox, '1400', { sentDaysAgo: 100 });
    const state = manifestPath(dir);
    const before = statSync(state).mtimeMs;

    purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });

    // state.json's mtime is what the orchestrator compares the PDF against. Bump it and the next
    // Go decides the book is out of date, tries to reprint it, and fails: the photographs it would
    // print are the ones we just deleted.
    assert.equal(statSync(state).mtimeMs, before, 'the "last decided" clock is left where it was');
    assert.ok(statSync(join(dir, '1400 Final.pdf')).mtimeMs >= statSync(state).mtimeMs, 'so the book still counts as current');
    assert.ok(readManifest(dir).photosPurgedAt, 'and the purge is still recorded');
  } finally {
    f.cleanup();
  }
});

test('a folder that is not an order is not an order', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.outbox, '.originals'), { recursive: true });
    writeFileSync(join(f.outbox, '.originals', 'kept.svg'), '<svg/>');
    writeFileSync(join(f.outbox, 'dedications.json.tmp'), '{}');

    assert.deepEqual(inspectOutbox({ outboxRoot: f.outbox, days: 30, now: NOW }), []);
    assert.ok(existsSync(join(f.outbox, '.originals', 'kept.svg')));
  } finally {
    f.cleanup();
  }
});

test('several orders are judged one at a time, not as a batch', () => {
  const f = fixture();
  try {
    order(f.outbox, '1400', { sentDaysAgo: 100 }); // purgeable
    order(f.outbox, '1401', { sentDaysAgo: 2 }); //   too recent
    order(f.outbox, '1402', { pdf: false, printed: false, sent: false }); // never finished
    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });

    assert.deepEqual(result.orders.map((o) => o.orderId), ['1400']);
    assert.deepEqual(result.skipped.map((o) => o.orderId), ['1401', '1402']);
    assert.equal(jpgs(join(f.outbox, '1401')).length, 2);
    assert.equal(jpgs(join(f.outbox, '1402')).length, 2);
  } finally {
    f.cleanup();
  }
});

test('a missing outbox is not a crash', () => {
  assert.deepEqual(inspectOutbox({ outboxRoot: join(tmpdir(), 'fma-not-here-at-all'), days: 30 }), []);
});

test('the retention window has to be a real number of days', () => {
  assert.throws(() => inspectOutbox({ outboxRoot: tmpdir(), days: 0 }), TypeError);
  assert.throws(() => inspectOutbox({ outboxRoot: tmpdir(), days: 1.5 }), TypeError);
});

// ---- the command line ------------------------------------------------------

test('purge deletes nothing unless it is told to', () => {
  assert.deepEqual(parseArgs([]), { yes: false, days: null });
  assert.deepEqual(parseArgs(['--yes']), { yes: true, days: null });
  assert.deepEqual(parseArgs(['--days', '60']), { yes: false, days: 60 });
  assert.throws(() => parseArgs(['--days', 'soon']), /positive whole number/);
  assert.throws(() => parseArgs(['--days', '0']), /positive whole number/);
});

test('the report says what it did, what it spared, and what it cannot promise', () => {
  const f = fixture();
  try {
    order(f.outbox, '1400', { sentDaysAgo: 100 });
    order(f.outbox, '1401', { sentDaysAgo: 2 });
    const text = report(purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW }));

    assert.match(text, /Would delete the photographs of 1 order/);
    assert.match(text, /1400 {2}\s*2 photo/);
    assert.match(text, /dispatched 100 days ago/, 'the age is measured from the marker the gate now reads');
    assert.doesNotMatch(text, /printed 100 days ago/, 'and no longer names the print, which is not the gate');
    assert.match(text, /Left alone:[\s\S]*1401/);
    assert.match(text, /also inside each "<order> Final\.pdf"/, 'the photographs are still in the book');
    assert.match(text, /Nothing has been deleted/);
  } finally {
    f.cleanup();
  }
});

test('the report separates historical backfills from real dispatches, and names the cap and the stalled', () => {
  const f = fixture();
  try {
    order(f.outbox, '1400', { sentDaysAgo: 100, backfilled: true });
    order(f.outbox, '1401', { sentDaysAgo: 100, backfilled: true });
    order(f.outbox, '1402', { sentDaysAgo: 100 });
    order(f.outbox, '1403', { printed: true, sent: false, printedDaysAgo: 400 });
    const text = report(purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, cap: 2 }));

    assert.match(text, /Eligible: 3 — 1 dispatched by hand, 2 backfilled from an old print\./);
    assert.match(text, /\(backfilled — printed before the lifecycle change\)/, 'and each historical row is labelled');
    assert.match(text, /Left for the next run \(a single run deletes at most 2\): 1 order/);
    assert.match(text, /Printed but never dispatched[\s\S]*1403 {2}printed 400 days ago/);
  } finally {
    f.cleanup();
  }
});

// ---- the operator's routes: report, then confirm (R19) ----------------------

/** Every file under a tree, with its bytes and mtime — the evidence that a "read-only" route really
 *  was. Compared whole, so a marker written anywhere in the fixture shows up. */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(root, path)] = `${statSync(path).mtimeMs}:${readFileSync(path).toString('base64')}`;
    }
  };
  walk(root);
  return out;
}

const SERVER_CONFIG = {
  generator: { baseUrl: 'https://example.test/gen/', mode: 'api' },
  builder: { baseUrl: 'https://example.test/builder' },
  paths: { inbox: './inbox', outbox: './outbox' },
  retentionDays: 30,
};

/** An ungated local studio over a fixture outbox — one implicit operator, no sign-in (KTD11).
 *  `dataDir` wires the autopilot's report/state folder, which purges on the same clock. */
async function localStudio(outbox, { dataDir = null } = {}) {
  const { server } = createReviewServer({
    config: dataDir ? { ...SERVER_CONFIG, shopify: { dataDir } } : SERVER_CONFIG,
    inboxRoot: join(outbox, '..', 'inbox'),
    outboxRoot: outbox,
    memoryRoot: outbox,
    driver: { generate: async () => {} },
    authEnv: {},
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    get: (p) => fetch(origin + p),
    post: (p, body) => fetch(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
    close: () => server.close(),
  };
}

test('the purge REPORT route writes nothing — the fixture tree is byte-identical afterwards', async () => {
  const f = fixture();
  let s;
  try {
    order(f.outbox, '1400', { sentDaysAgo: 100, ref: REAL });
    order(f.outbox, '1401', { sentDaysAgo: 2, ref: REAL });
    order(f.outbox, '1402', { printed: true, sent: false, printedDaysAgo: 400, ref: REAL });
    s = await localStudio(f.outbox);
    const before = snapshot(f.outbox);

    const res = await s.get('/api/purge/report');
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.dryRun, true, 'the report is a dry run and says so');
    assert.deepEqual(body.orders.map((o) => o.orderId), ['1400']);
    assert.equal(body.orders[0].photos, 2, 'counts, not paths');
    assert.equal(body.orders[0].backfilled, false);
    assert.deepEqual(body.stalled.map((o) => o.orderId), ['1402'], 'the never-dispatched order is surfaced');
    assert.ok(body.skipped.some((o) => o.orderId === '1401'));
    assert.ok(body.warning.includes('Final.pdf'), 'and the caveat travels with it');
    assert.ok(!JSON.stringify(body).includes(f.outbox), 'no filesystem path crosses to the page');

    assert.deepEqual(snapshot(f.outbox), before, 'reading what a purge would do changed not one byte');
  } finally {
    s?.close();
    f.cleanup();
  }
});

test('the purge route needs a separate confirmation, and then takes only the photographs', async () => {
  const f = fixture();
  let s;
  try {
    const dir = order(f.outbox, '1400', { sentDaysAgo: 100, ref: REAL });
    s = await localStudio(f.outbox);

    const unconfirmed = await s.post('/api/purge/confirm', {});
    assert.equal(unconfirmed.status, 409, 'the dry-run posture is the default even on the deleting route');
    assert.equal((await unconfirmed.json()).code, 'confirm-required');
    assert.equal(jpgs(dir).length, 2, 'and nothing was deleted on the way to that refusal');

    const res = await s.post('/api/purge/confirm', { confirm: true });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.dryRun, false);
    assert.equal(body.photos, 2);

    assert.deepEqual(jpgs(dir), [], 'the photographs are gone');
    assert.ok(existsSync(join(dir, 'a.svg')), 'the line art survives — it is a drawing, not a face');
    assert.ok(existsSync(join(dir, 'a_bw.png')));
    assert.ok(existsSync(join(dir, '1400 Final.pdf')), 'and so does the built book');
  } finally {
    s?.close();
    f.cleanup();
  }
});

test('over HTTP: undo the print, then confirm a purge — the photographs of the re-queued book survive', async () => {
  const f = fixture();
  let s;
  try {
    // The two routes an operator can genuinely press in this order on a Tuesday morning: "Vrátit" on
    // an order whose print went wrong, then the úklid panel's Smazat. Before the invariant, the
    // second one deleted the photographs the first one had just put back in the print queue.
    const dir = order(f.outbox, '1400', { sentDaysAgo: 100, backfilled: true, ref: REAL });
    s = await localStudio(f.outbox);

    const undo = await s.post('/api/1400/unprinted');
    assert.equal(undo.status, 200, 'the print is undone');
    assert.equal(existsSync(join(dir, 'printed.json')), false, 'and the marker really is gone, not merely reported gone');

    const report = await (await s.get('/api/purge/report')).json();
    assert.deepEqual(report.orders, [], 'the report offers nothing');
    assert.ok(report.skipped.some((o) => o.orderId === '1400' && /dispatched but not printed/.test(o.skip)), 'and says why, by name');

    const purged = await s.post('/api/purge/confirm', { confirm: true });
    assert.equal(purged.status, 200);
    assert.equal((await purged.json()).photos, 0, 'the confirmation deletes nothing');
    assert.equal(jpgs(dir).length, 2, 'the customer\'s photographs are on disk for the reprint');
  } finally {
    s?.close();
    f.cleanup();
  }
});

test('the REPORT names the autopilot files the confirmation will clear — the two routes describe one act', async () => {
  const f = fixture();
  const a = autopilotDir({ reportDaysAgo: 400, stateDaysAgo: 400 });
  let s;
  try {
    // The confirm route always cleared the night report and handled-set as well, and the report route
    // said nothing about them — so the panel's stated contract ("this is exactly what confirming
    // does") was false for two files carrying order numbers. The fixture had no shopify block, which
    // is why nothing noticed.
    order(f.outbox, '1400', { sentDaysAgo: 100, ref: REAL });
    s = await localStudio(f.outbox, { dataDir: a.dir });

    const report = await (await s.get('/api/purge/report')).json();
    assert.deepEqual(report.autopilotFiles.sort(), ['autopilot-state.json', 'overnight-report.json'], 'the report names them');
    assert.ok(existsSync(a.rp) && existsSync(a.sp), 'and, being a report, deletes neither');

    const confirmed = await (await s.post('/api/purge/confirm', { confirm: true })).json();
    assert.deepEqual(confirmed.autopilotFiles.sort(), ['autopilot-state.json', 'overnight-report.json'], 'the confirmation clears exactly what was named');
    assert.equal(existsSync(a.rp), false, 'the night report is gone');
    assert.equal(existsSync(a.sp), false, 'and so is the handled-set');
  } finally {
    s?.close();
    a.cleanup();
    f.cleanup();
  }
});

test('the purge routes are refused for the printer and served for the operator', async () => {
  const f = fixture();
  const dir = order(f.outbox, '1400', { sentDaysAgo: 100, ref: REAL });
  const hash = await hashPassword('correct horse battery staple', { logN: 14, r: 8, p: 1 });
  const { server } = createReviewServer({
    config: { ...SERVER_CONFIG, accounts: { dataDir: join(f.root, 'accounts') } },
    inboxRoot: join(f.root, 'inbox'),
    outboxRoot: f.outbox,
    memoryRoot: f.outbox,
    driver: { generate: async () => {} },
    authEnv: { [ROLE_ENV_VARS.operator]: hash, [ROLE_ENV_VARS.printer]: hash },
  });
  try {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const signIn = async (username) => {
      const res = await fetch(`${origin}${SIGN_IN_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'correct horse battery staple' }),
      });
      assert.equal(res.status, 200, `${username} signs in`);
      return String(res.headers.get('set-cookie')).split(';')[0];
    };
    const printer = await signIn('Jirka');
    const operator = await signIn('David');

    for (const [method, path] of [['GET', '/api/purge/report'], ['POST', '/api/purge/confirm']]) {
      const res = await fetch(origin + path, {
        method,
        headers: { cookie: printer, 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ confirm: true }) : undefined,
      });
      assert.equal(res.status, 403, `${method} ${path} is refused for the printer`);
      assert.equal((await res.json()).code, 'forbidden');
    }
    assert.equal(jpgs(dir).length, 2, 'the refusal is a refusal, not a silent deletion');

    const allowed = await fetch(`${origin}/api/purge/report`, { headers: { cookie: operator } });
    assert.equal(allowed.status, 200, 'the operator reads the same report');
    assert.equal((await allowed.json()).orders.length, 1);
  } finally {
    server.close();
    f.cleanup();
  }
});

// ---- overnight autopilot: report + state age out on retentionDays -----------

/** A data dir holding a night report + state file, each aged to a chosen number of days. */
function autopilotDir({ reportDaysAgo = 0, stateDaysAgo = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fma-autopilot-purge-'));
  const rp = join(dir, 'overnight-report.json');
  const sp = join(dir, 'autopilot-state.json');
  writeFileSync(rp, '{}');
  writeFileSync(sp, '{}');
  age(rp, reportDaysAgo * DAY);
  age(sp, stateDaysAgo * DAY);
  return { dir, rp, sp, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a stale night report/state (older than retentionDays) is removed; a fresh one is kept', () => {
  const a = autopilotDir({ reportDaysAgo: 40, stateDaysAgo: 2 });
  try {
    // Dry run reports both but touches nothing.
    const dry = purgeAutopilotData({ dataDir: a.dir, days: 30, now: NOW });
    assert.deepEqual(dry.removed.map((f) => f.name), ['overnight-report.json']);
    assert.deepEqual(dry.kept.map((f) => f.name), ['autopilot-state.json']);
    assert.ok(existsSync(a.rp), 'a dry run deletes nothing');

    // For real: the stale report goes, the fresh state stays.
    purgeAutopilotData({ dataDir: a.dir, days: 30, now: NOW, dryRun: false });
    assert.equal(existsSync(a.rp), false, 'the 40-day-old report is cleared');
    assert.equal(existsSync(a.sp), true, 'the 2-day-old state is kept — autopilot is still active');
  } finally {
    a.cleanup();
  }
});

test('inspectAutopilotData is a no-op when autopilot never ran (no data dir)', () => {
  assert.deepEqual(inspectAutopilotData({ dataDir: join(tmpdir(), 'fma-nope-does-not-exist'), days: 30, now: NOW }), []);
  assert.deepEqual(inspectAutopilotData({ dataDir: null, days: 30, now: NOW }), []);
  assert.throws(() => inspectAutopilotData({ dataDir: '/x', days: 0, now: NOW }), /positive integer/);
});
