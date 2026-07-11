import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessIntake } from '../src/intake.js';

// A 64-bit dHash with the given bit positions set to 1.
const H = (...on) => { const h = new Uint8Array(64); for (const b of on) h[b] = 1; return h; };

// A canned per-photo adapter result. Overrides let a test make one photo blurry, tiny, a duplicate…
const photo = (base, over = {}) => ({
  base,
  path: base,
  readable: over.readable ?? true,
  sha1: over.sha1 ?? base, // distinct bytes per photo unless a test says otherwise
  width: 3000,
  height: 4000,
  hash: over.hash ?? H(), // all-zero by default; tests that mix photos pass distinct hashes
  resolution: over.resolution ?? { verdict: 'ok', reason: 'ok', mp: 12, shortSide: 3000 },
  blur: over.blur ?? { verdict: 'ok', reason: 'ok', variance: 500 },
  exposure: over.exposure ?? { verdict: 'ok', reason: 'ok', mean: 128, clip: 0 },
});

// Build an injectable assess() from a base -> result map, keyed by the photo path (== base here).
const fakeAssess = (photos) => {
  const byPath = new Map(photos.map((p) => [p.path, p]));
  return async (path) => byPath.get(path);
};
const orderOf = (photos) => ({ orderId: 'X', photos: photos.map((p) => p.path) });

const run = (photos, extra = {}) =>
  assessIntake({ order: orderOf(photos), assess: fakeAssess(photos), ...extra });

test('a clean order with the right count passes with no findings', async () => {
  const photos = [photo('a', { hash: H(0, 1, 2, 3, 4, 5) }), photo('b', { hash: H(20, 21, 22, 23, 24, 25) })];
  const r = await run(photos, { expected: 2 });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.findings.length, 0);
  assert.equal(r.emailCase, null);
});

test('a blurry photo is a warn, not a hold', async () => {
  const photos = [
    photo('a', { hash: H(0, 1, 2, 3, 4, 5), blur: { verdict: 'warn', reason: 'blurry', variance: 42 } }),
    photo('b', { hash: H(20, 21, 22, 23, 24, 25) }),
  ];
  const r = await run(photos, { expected: 2 });
  assert.equal(r.verdict, 'warn');
  const f = r.findings.find((x) => x.check === 'blur');
  assert.equal(f.reason, 'blurry');
  assert.equal(f.variance, 42);
  assert.equal(r.emailCase, null); // a warn order still generates
});

test('identical files are a hold and shrink the unique count', async () => {
  // Two of the three photos are the same bytes; expected 3 -> only 2 distinct -> also missing.
  const photos = [
    photo('a', { sha1: 'same', hash: H(0) }),
    photo('b', { sha1: 'same', hash: H(0) }),
    photo('c', { sha1: 'other', hash: H(40, 41, 42, 43, 44, 45) }),
  ];
  const r = await run(photos, { expected: 3 });
  assert.equal(r.verdict, 'hold');
  assert.equal(r.unique, 2);
  assert.ok(r.findings.some((f) => f.reason === 'duplicate-identical'));
  assert.ok(r.findings.some((f) => f.reason === 'missing-photos'));
  assert.equal(r.emailCase, 'missing'); // missing outranks duplicate
});

test('near-duplicate distinct files are a warn, and exact dupes are not double-counted', async () => {
  const photos = [
    photo('a', { hash: H(0, 1, 2) }),
    photo('b', { hash: H(0, 1, 2, 3, 4) }), // 2 bits from a -> within dupHammingMax
  ];
  const r = await run(photos, { expected: 2 });
  const dupes = r.findings.filter((f) => f.check === 'duplicate');
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].reason, 'possible-duplicate');
  assert.equal(r.verdict, 'warn');
});

test('missing photos is a hold; the finding carries the shortfall', async () => {
  const photos = [photo('a', { hash: H(0, 1, 2, 3, 4, 5) }), photo('b', { hash: H(20, 21, 22, 23, 24, 25) })];
  const r = await run(photos, { expected: 8 });
  const f = r.findings.find((x) => x.check === 'count');
  assert.equal(f.reason, 'missing-photos');
  assert.equal(f.missing, 6);
  assert.equal(r.verdict, 'hold');
  assert.equal(r.emailCase, 'missing');
});

test('an unknown expected count never holds', async () => {
  const photos = [photo('a', { hash: H(0, 1, 2, 3, 4, 5) }), photo('b', { hash: H(20, 21, 22, 23, 24, 25) })];
  const r = await run(photos, { expected: null });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.emailCase, null);
});

test('an unreadable file holds the order and drives the unreadable email', async () => {
  const photos = [
    photo('a', { hash: H(0) }),
    photo('bad', { readable: false, sha1: 'x', hash: H(), resolution: { verdict: 'hold', reason: 'unreadable', mp: 0, shortSide: 0 } }),
  ];
  const r = await run(photos, { expected: 2 });
  assert.equal(r.verdict, 'hold');
  assert.ok(r.findings.some((f) => f.reason === 'unreadable'));
  assert.equal(r.emailCase, 'unreadable');
});
