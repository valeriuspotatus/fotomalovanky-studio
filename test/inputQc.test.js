import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessResolution,
  laplacianVariance,
  assessBlur,
  assessExposure,
  dHash,
  hamming,
  nearDuplicatePairs,
  assessCount,
  worstVerdict,
} from '../src/inputQc.js';

// A small square grey buffer, filled flat unless painted.
const grid = (w, h, v = 128) => new Uint8Array(w * h).fill(v);
const checkerboard = (w, h) => {
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x + y) % 2 ? 255 : 0;
  return px;
};
// Left-to-right ramp: column x has luminance proportional to x.
const rampLR = (w, h) => {
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = Math.round((x / (w - 1)) * 255);
  return px;
};

// ---- resolution -------------------------------------------------------------

test('a tiny photo is held as low-resolution', () => {
  const r = assessResolution(300, 300); // 0.09 MP, short side 300
  assert.equal(r.verdict, 'hold');
  assert.equal(r.reason, 'low-resolution');
});

test('a long thin strip is held even though its megapixels pass', () => {
  const r = assessResolution(4000, 300); // 1.2 MP but short side only 300
  assert.equal(r.verdict, 'hold');
  assert.equal(r.reason, 'low-resolution');
});

test('a middling photo warns as smallish', () => {
  const r = assessResolution(800, 600); // 0.48 MP, short side 600
  assert.equal(r.verdict, 'warn');
  assert.equal(r.reason, 'smallish');
});

test('a normal phone photo passes', () => {
  const r = assessResolution(3024, 4032); // ~12 MP
  assert.equal(r.verdict, 'ok');
});

test('zero dimensions read as unreadable', () => {
  const r = assessResolution(0, 0);
  assert.equal(r.verdict, 'hold');
  assert.equal(r.reason, 'unreadable');
});

// ---- blur -------------------------------------------------------------------

test('a flat image has no Laplacian variance and warns as blurry', () => {
  const px = grid(16, 16, 128);
  assert.equal(laplacianVariance(px, 16, 16), 0);
  const r = assessBlur(px, 16, 16);
  assert.equal(r.verdict, 'warn');
  assert.equal(r.reason, 'blurry');
});

test('a hard-edged checkerboard is sharp and passes', () => {
  const px = checkerboard(16, 16);
  assert.ok(laplacianVariance(px, 16, 16) > 60, 'edges give high variance');
  assert.equal(assessBlur(px, 16, 16).verdict, 'ok');
});

test('a buffer too small to measure scores zero rather than throwing', () => {
  assert.equal(laplacianVariance(new Uint8Array(4), 2, 2), 0);
});

// ---- exposure ---------------------------------------------------------------

test('an almost-black photo warns as dark', () => {
  const r = assessExposure(grid(16, 16, 10));
  assert.equal(r.verdict, 'warn');
  assert.equal(r.reason, 'dark');
});

test('an almost-white photo warns as overexposed', () => {
  const r = assessExposure(grid(16, 16, 240));
  assert.equal(r.verdict, 'warn');
  assert.equal(r.reason, 'overexposed');
});

test('a well-exposed mid-grey photo passes', () => {
  const r = assessExposure(grid(16, 16, 128));
  assert.equal(r.verdict, 'ok');
});

test('heavy clipping warns even at an acceptable mean', () => {
  // Half pure black, half pure white: mean ~128 but every pixel is clipped.
  const px = new Uint8Array(1000);
  for (let i = 0; i < 500; i++) px[i] = 255;
  const r = assessExposure(px);
  assert.equal(r.verdict, 'warn');
  assert.equal(r.reason, 'clipped');
});

// ---- duplicates -------------------------------------------------------------

test('identical images hash the same (Hamming 0)', () => {
  const a = dHash(rampLR(32, 32), 32, 32);
  const b = dHash(rampLR(32, 32), 32, 32);
  assert.equal(hamming(a, b), 0);
});

test('a mirrored ramp hashes far away', () => {
  const lr = rampLR(32, 32);
  const rl = new Uint8Array(32 * 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) rl[y * 32 + x] = lr[y * 32 + (31 - x)];
  const d = hamming(dHash(lr, 32, 32), dHash(rl, 32, 32));
  assert.ok(d > 5, `mirrored image should be far apart, got ${d}`);
});

test('nearDuplicatePairs finds the matching pair and ignores the odd one out', () => {
  const same1 = dHash(rampLR(32, 32), 32, 32);
  const same2 = dHash(rampLR(32, 32), 32, 32);
  const other = dHash(checkerboard(32, 32), 32, 32);
  const pairs = nearDuplicatePairs([same1, same2, other]);
  assert.deepEqual(pairs, [[0, 1]]);
});

// ---- count ------------------------------------------------------------------

test('fewer unique photos than the product expects is a hold', () => {
  const r = assessCount({ expected: 8, unique: 5 });
  assert.equal(r.verdict, 'hold');
  assert.equal(r.reason, 'missing-photos');
});

test('more photos than expected is a warn', () => {
  const r = assessCount({ expected: 8, unique: 10 });
  assert.equal(r.verdict, 'warn');
  assert.equal(r.reason, 'extra-photos');
});

test('the right count passes', () => {
  assert.equal(assessCount({ expected: 8, unique: 8 }).verdict, 'ok');
});

test('an unknown expected count is advisory, never a hold', () => {
  const r = assessCount({ expected: null, unique: 8 });
  assert.equal(r.verdict, 'info');
  assert.equal(r.reason, 'expected-unknown');
});

// ---- verdict rollup ---------------------------------------------------------

test('worstVerdict escalates to hold and treats info as proceed', () => {
  assert.equal(worstVerdict(['ok', 'warn', 'hold']), 'hold');
  assert.equal(worstVerdict(['ok', 'warn', 'info']), 'warn');
  assert.equal(worstVerdict(['ok', 'info']), 'ok');
  assert.equal(worstVerdict([]), 'ok');
});
