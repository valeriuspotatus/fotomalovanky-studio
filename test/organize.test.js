import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPhoto, photoBase, outputNames, outputPaths, copyWithRetry } from '../src/organize.js';

// ---- the Windows file lock ---------------------------------------------------
// The review grid reads a photo to draw its tile while the run rewrites that same photo.
// Windows refuses the overwrite for as long as the reader's handle lives. It is momentary.

const lockedOnce = (times, code = 'UNKNOWN') => {
  let calls = 0;
  return () => {
    if (++calls <= times) { const e = new Error('copyfile failed'); e.code = code; throw e; }
    return calls;
  };
};

test('a momentarily locked file is copied once the lock clears', async () => {
  const copy = lockedOnce(2);
  const sleeps = [];
  await copyWithRetry('a', 'b', { copy, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(sleeps, [60, 120], 'backs off further each attempt');
});

test('a lock that never clears surfaces the real error rather than looping', async () => {
  const copy = lockedOnce(Infinity, 'EBUSY');
  await assert.rejects(() => copyWithRetry('a', 'b', { copy, attempts: 3, sleep: async () => {} }), /copyfile failed/);
});

test('an error that is not a lock is not retried — a missing file will never appear', async () => {
  let calls = 0;
  const copy = () => { calls++; const e = new Error('no such file'); e.code = 'ENOENT'; throw e; };
  await assert.rejects(() => copyWithRetry('a', 'b', { copy, sleep: async () => {} }), /no such file/);
  assert.equal(calls, 1);
});

test('an unlocked copy happens once, with no waiting', async () => {
  let calls = 0;
  const sleeps = [];
  await copyWithRetry('a', 'b', { copy: () => calls++, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test('isPhoto matches supported and explicitly-held inputs case-insensitively', () => {
  assert.ok(isPhoto('a.jpg'));
  assert.ok(isPhoto('a.JPEG'));
  assert.ok(isPhoto('a.png'));
  assert.ok(isPhoto('a.webp'));
  assert.ok(isPhoto('a.HEIC'));
  assert.ok(isPhoto('a.heif'));
  assert.ok(!isPhoto('a_bw.png'));
  assert.ok(!isPhoto('a_bw.svg'));
});

test('photoBase strips directory and extension', () => {
  assert.equal(photoBase('orders/123/abc.jpg'), 'abc');
});

test('outputNames produces the builder triple (jpg + _bw.png + svg)', () => {
  assert.deepEqual(outputNames('abc.jpg'), {
    base: 'abc',
    original: 'abc.jpg',
    coloringPng: 'abc_bw.png',
    coloringSvg: 'abc.svg',
  });
});

test('outputNames normalizes a .jpeg input original to .jpg', () => {
  const names = outputNames('photo.jpeg');
  assert.equal(names.original, 'photo.jpg');
  assert.equal(names.coloringSvg, 'photo.svg');
  assert.equal(names.coloringPng, 'photo_bw.png');
});

test('outputPaths joins names into the order directory', () => {
  const paths = outputPaths('abc.jpg', 'out/order1');
  assert.match(paths.original, /order1[\\/]abc\.jpg$/);
  assert.match(paths.coloringSvg, /order1[\\/]abc\.svg$/);
  assert.match(paths.coloringPng, /order1[\\/]abc_bw\.png$/);
});
