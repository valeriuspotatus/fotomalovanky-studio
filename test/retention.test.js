import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectOutbox, purgeOriginals, inspectAutopilotData, purgeAutopilotData } from '../src/retention.js';
import { parseArgs, report } from '../src/purge.js';
import { STATES, emptyManifest, setStatus, writeManifest, readManifest, manifestPath } from '../src/manifest.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 10); // a fixed "today", so nothing here depends on the wall clock

const age = (path, ms) => {
  const t = (NOW - ms) / 1000;
  utimesSync(path, t, t);
};

/** An order folder holding two photos, their line art, a manifest, (optionally) a printed book, and
 *  (optionally) the 'vytištěno' marker — the purge gate. `printed` defaults on; set it false for an
 *  order that was only sent, or never finished at all. */
function order(outbox, orderId, { pdf = true, printed = true, printedDaysAgo = 100, staleDecision = false, photos = ['a', 'b'] } = {}) {
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
  age(manifestPath(dir), printedDaysAgo * DAY + (staleDecision ? -1 * DAY : 1 * DAY));

  if (pdf) {
    const pdfPath = join(dir, `${orderId} Final.pdf`);
    writeFileSync(pdfPath, '%PDF-1.4');
    age(pdfPath, printedDaysAgo * DAY);
  }
  if (printed) {
    const printedPath = join(dir, 'printed.json');
    writeFileSync(printedPath, JSON.stringify({ at: new Date(NOW - printedDaysAgo * DAY).toISOString() }));
    age(printedPath, printedDaysAgo * DAY); // the marker's mtime is the retention clock
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

test('a settled book older than the retention window gives up its photographs', () => {
  const f = fixture();
  try {
    const dir = order(f.outbox, '1400', { printedDaysAgo: 100 });
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
    const dir = order(f.outbox, '1400', { printedDaysAgo: 100 });
    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW });

    assert.equal(result.dryRun, true);
    assert.equal(result.photos, 2, 'it still says what it would take');
    assert.equal(jpgs(dir).length, 2, 'and takes none of it');
    assert.equal(readManifest(dir).photosPurgedAt, undefined);
  } finally {
    f.cleanup();
  }
});

test('a book printed inside the window is left alone', () => {
  const f = fixture();
  try {
    const dir = order(f.outbox, '1400', { printedDaysAgo: 10 });
    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });

    assert.equal(result.photos, 0);
    assert.equal(jpgs(dir).length, 2);
    assert.match(result.skipped[0].skip, /printed 10 days ago, keeping for 30/);
  } finally {
    f.cleanup();
  }
});

test('an order whose book was never finished is never touched, however old', () => {
  const f = fixture();
  try {
    const dir = order(f.outbox, '1400', { pdf: false, printed: false, printedDaysAgo: 900 });
    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });

    assert.equal(jpgs(dir).length, 2, 'its photographs are the only way to print it');
    assert.match(result.skipped[0].skip, /not confirmed printed yet/);
  } finally {
    f.cleanup();
  }
});

test('an order sent to Jirka but not yet confirmed printed keeps its photos (N3 — odesláno is not vytištěno)', () => {
  const f = fixture();
  try {
    // Book built and delivered long ago, but no printed.json: the WhatsApp message could have been lost.
    const dir = order(f.outbox, '1400', { printed: false, printedDaysAgo: 900 });
    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });

    assert.equal(jpgs(dir).length, 2, 'nothing is deleted until the print is confirmed');
    assert.match(result.skipped[0].skip, /not confirmed printed yet/);
  } finally {
    f.cleanup();
  }
});

test('an order decided after its book was printed keeps its photographs', () => {
  const f = fixture();
  try {
    // The operator rejected a photo last week; the PDF on disk is not the book they want.
    const dir = order(f.outbox, '1400', { printedDaysAgo: 100, staleDecision: true });
    const result = purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW, dryRun: false });

    assert.equal(jpgs(dir).length, 2, 'it has still to be reprinted, and reprinting needs them');
    assert.match(result.skipped[0].skip, /decision changed after the book was printed/);
  } finally {
    f.cleanup();
  }
});

test('purging twice is a no-op, not an error', () => {
  const f = fixture();
  try {
    order(f.outbox, '1400', { printedDaysAgo: 100 });
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
    const dir = order(f.outbox, '1400', { printedDaysAgo: 100 });
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
    order(f.outbox, '1400', { printedDaysAgo: 100 }); // purgeable
    order(f.outbox, '1401', { printedDaysAgo: 2 }); //   too recent
    order(f.outbox, '1402', { pdf: false, printed: false }); // never finished
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
    order(f.outbox, '1400', { printedDaysAgo: 100 });
    order(f.outbox, '1401', { printedDaysAgo: 2 });
    const text = report(purgeOriginals({ outboxRoot: f.outbox, days: 30, now: NOW }));

    assert.match(text, /Would delete the photographs of 1 order/);
    assert.match(text, /1400 {2}\s*2 photo/);
    assert.match(text, /Left alone:[\s\S]*1401/);
    assert.match(text, /also inside each "<order> Final\.pdf"/, 'the photographs are still in the book');
    assert.match(text, /Nothing has been deleted/);
  } finally {
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
