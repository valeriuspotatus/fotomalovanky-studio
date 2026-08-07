import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { readAdSpend, writeAdSpend, spendForWindow, adSpendPath, AdSpendError, SPEND_SOURCES } from '../src/adSpend.js';

// The store behind the homepage's return-on-spend figure. Everything here is about one property:
// the page must never present a number it cannot stand behind. Missing spend stays missing, a typed
// correction beats whatever was fetched, and a corrupted file reads as no data rather than as zero.

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-spend-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const WEEK = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-07T23:59:59.000Z' };
const WINDOW = { from: '2026-07-09T00:00:00.000Z', to: '2026-08-08T00:00:00.000Z' };

test('a typed figure comes back for a window that overlaps its period', () => {
  const f = fixture();
  try {
    writeAdSpend(f.dir, { ...WEEK, amount: 6200 });
    const s = spendForWindow(f.dir, WINDOW);
    assert.equal(s.amount, 6200);
    assert.equal(s.source, SPEND_SOURCES.TYPED);
    assert.equal(s.currency, 'CZK');
  } finally {
    f.cleanup();
  }
});

test('a window with no record returns null — not zero', () => {
  // Zero would compute a return on spend of infinity and read as "the ads are free", which is the
  // most flattering possible lie about the one number this page exists to answer.
  const f = fixture();
  try {
    assert.equal(spendForWindow(f.dir, WINDOW), null, 'nothing stored at all');
    writeAdSpend(f.dir, { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z', amount: 999 });
    assert.equal(spendForWindow(f.dir, WINDOW), null, 'and nothing that overlaps this window');
  } finally {
    f.cleanup();
  }
});

test('a typed figure beats a fetched one for the same period, and is not added to it', () => {
  // The reason the operator typed one is that the fetched number was absent, stale or wrong.
  // Summing the two would double-count the very figure the correction was meant to replace.
  const f = fixture();
  try {
    writeAdSpend(f.dir, { ...WEEK, amount: 9999, source: SPEND_SOURCES.META });
    writeAdSpend(f.dir, { ...WEEK, amount: 6200, source: SPEND_SOURCES.TYPED });
    const s = spendForWindow(f.dir, WINDOW);
    assert.equal(s.amount, 6200, 'the typed figure, alone');
    assert.equal(s.source, SPEND_SOURCES.TYPED, 'and the page can say it was entered by hand');
  } finally {
    f.cleanup();
  }
});

test('several weekly figures inside one window are summed', () => {
  const f = fixture();
  try {
    writeAdSpend(f.dir, { from: '2026-07-13T00:00:00.000Z', to: '2026-07-19T00:00:00.000Z', amount: 1000 });
    writeAdSpend(f.dir, { from: '2026-07-20T00:00:00.000Z', to: '2026-07-26T00:00:00.000Z', amount: 1500 });
    writeAdSpend(f.dir, { from: '2026-07-27T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z', amount: 2000 });
    const s = spendForWindow(f.dir, WINDOW);
    assert.equal(s.amount, 4500);
    assert.equal(s.records, 3);
  } finally {
    f.cleanup();
  }
});

test('correcting a typo replaces the figure rather than adding a second one', () => {
  const f = fixture();
  try {
    writeAdSpend(f.dir, { ...WEEK, amount: 62000 }); // a slipped zero
    writeAdSpend(f.dir, { ...WEEK, amount: 6200 });
    assert.equal(readAdSpend(f.dir).length, 1, 'one record for one period and source');
    assert.equal(spendForWindow(f.dir, WINDOW).amount, 6200);
  } finally {
    f.cleanup();
  }
});

test('a nonsense figure is refused rather than stored', () => {
  const f = fixture();
  try {
    assert.throws(() => writeAdSpend(f.dir, { ...WEEK, amount: -5 }), AdSpendError, 'negative spend');
    assert.throws(() => writeAdSpend(f.dir, { ...WEEK, amount: 'lots' }), AdSpendError, 'not a number');
    assert.throws(() => writeAdSpend(f.dir, { amount: 100 }), AdSpendError, 'no period');
    assert.throws(() => writeAdSpend(f.dir, { from: WEEK.to, to: WEEK.from, amount: 100 }), AdSpendError, 'period runs backwards');
    assert.deepEqual(readAdSpend(f.dir), [], 'and nothing was written');
  } finally {
    f.cleanup();
  }
});

test('an extra field on the body does not reach the file', () => {
  // The write path is fed from an HTTP body, so the record is rebuilt field by field — the same
  // reasoning as the metrics allowlist, applied to a file somebody can POST into.
  const f = fixture();
  try {
    writeAdSpend(f.dir, { ...WEEK, amount: 6200, note: 'hofbauerova@example.cz', currency: 'CZK' });
    const raw = readFileSync(adSpendPath(f.dir), 'utf8');
    assert.ok(!raw.includes('hofbauerova'), 'the extra field is dropped');
    assert.deepEqual(Object.keys(readAdSpend(f.dir)[0]).sort(), ['amount', 'at', 'currency', 'from', 'source', 'to']);
  } finally {
    f.cleanup();
  }
});

test('a hand-edited or truncated file reads as no data, not as a crash', () => {
  const f = fixture();
  try {
    mkdirSync(f.dir, { recursive: true });
    writeFileSync(adSpendPath(f.dir), '{"version":1,"records":[{"amount":');
    assert.deepEqual(readAdSpend(f.dir), []);
    assert.equal(spendForWindow(f.dir, WINDOW), null);

    writeFileSync(adSpendPath(f.dir), JSON.stringify({ version: 1, records: [{ amount: 5 }, null, 'nonsense'] }));
    assert.deepEqual(readAdSpend(f.dir), [], 'and a record missing its period is dropped, not half-read');
  } finally {
    f.cleanup();
  }
});

test('the file is written 0600, because the disk it lives on is shared', { skip: platform() === 'win32' ? 'Windows reports 666 for chmod 0600' : false }, () => {
  const f = fixture();
  try {
    writeAdSpend(f.dir, { ...WEEK, amount: 6200 });
    assert.equal(statSync(adSpendPath(f.dir)).mode & 0o777, 0o600);
  } finally {
    f.cleanup();
  }
});
