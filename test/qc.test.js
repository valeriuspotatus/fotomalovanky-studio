import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessColoringPixels, assessColoringSvg, assessSolidFill, measureSolidFill } from '../src/qc.js';

const solid = (value, n = 1000) => new Uint8Array(n).fill(value);

// A 512x512 white page. blockPx = 512/128 = 4, so the page is a 128x128 grid of blocks and
// maxSolidBlob (0.05%) allows a connected solid run of up to 8 blocks — a 16x16px mark.
const PAGE = 512;
const page = () => new Uint8Array(PAGE * PAGE).fill(255);
const paint = (px, x0, y0, w, h, v = 0) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px[y * PAGE + x] = v;
  return px;
};
const assessPage = (px, opts) => assessSolidFill(px, PAGE, PAGE, opts);

test('near-blank (all white) coloring is flagged', () => {
  const r = assessColoringPixels(solid(255));
  assert.equal(r.verdict, 'flagged');
  assert.equal(r.reason, 'near-blank');
});

test('near-solid (all black) coloring is flagged', () => {
  const r = assessColoringPixels(solid(0));
  assert.equal(r.verdict, 'flagged');
  assert.equal(r.reason, 'near-solid');
});

test('a normal line-art coverage passes', () => {
  // 10% ink: 100 dark pixels out of 1000, rest white.
  const px = new Uint8Array(1000).fill(255);
  for (let i = 0; i < 100; i++) px[i] = 0;
  const r = assessColoringPixels(px);
  assert.equal(r.verdict, 'ok');
  assert.ok(Math.abs(r.coverage - 0.1) < 1e-9);
});

test('an empty pixel buffer is flagged', () => {
  const r = assessColoringPixels(new Uint8Array(0));
  assert.equal(r.verdict, 'flagged');
  assert.equal(r.reason, 'empty-image');
});

// ---- solid fill -------------------------------------------------------------
// The defect: the generator fills hair, dark clothing and shadows solid black instead of
// outlining them. Ink coverage cannot see it (such a page is ~14% ink, far below maxInk).

test('a filled hair-sized mass is flagged as solid-fill', () => {
  const r = assessPage(paint(page(), 100, 100, 48, 48));
  assert.equal(r.verdict, 'flagged');
  assert.equal(r.reason, 'solid-fill');
  assert.ok(r.solidBlob > 0.0005, `solidBlob ${r.solidBlob} should exceed the limit`);
});

test('hatching is not solid fill — the white paper between the lines saves it', () => {
  // 1px lines every 4px: a quarter of each block is ink, nothing is "solid".
  const px = page();
  for (let y = 0; y < PAGE; y++) for (let x = 0; x < PAGE; x += 4) px[y * PAGE + x] = 0;
  const r = assessPage(px);
  assert.equal(r.verdict, 'ok');
  assert.equal(r.solidFill, 0);
});

test('dense hatching at half duty is still not solid fill', () => {
  const px = page();
  for (let y = 0; y < PAGE; y++) for (let x = 0; x < PAGE; x += 4) { px[y * PAGE + x] = 0; px[y * PAGE + x + 1] = 0; }
  const r = assessPage(px);
  assert.equal(r.verdict, 'ok');
});

test('a pupil-sized solid dot passes — filled pupils are wanted, not a defect', () => {
  const r = assessPage(paint(page(), 200, 200, 8, 8));
  assert.equal(r.verdict, 'ok');
  assert.ok(r.solidBlob > 0, 'the dot is measured, just tolerated');
});

test('solid area scattered too thin to connect is caught by the total backstop', () => {
  // 200 isolated 4x4 marks, each one block, separated so none touch: blob stays tiny but the
  // total solid area passes 1%. This is what a black-checked plaid shirt looks like.
  const px = page();
  for (let k = 0; k < 200; k++) paint(px, (k % 64) * 8, Math.floor(k / 64) * 8, 4, 4);
  const r = assessPage(px);
  assert.equal(r.verdict, 'flagged');
  assert.equal(r.reason, 'solid-fill');
  assert.ok(r.solidBlob <= 0.0005, `no single blob is large (${r.solidBlob})`);
  assert.ok(r.solidFill > 0.01, `total solid area ${r.solidFill} should exceed the backstop`);
});

test('a clean white page has no solid fill', () => {
  const r = assessPage(page());
  assert.equal(r.verdict, 'ok');
  assert.equal(r.solidFill, 0);
  assert.equal(r.solidBlob, 0);
});

test('the measure is scale-invariant: the same mark on a bigger page scores the same', () => {
  const small = measureSolidFill(paint(page(), 100, 100, 48, 48), PAGE, PAGE);
  const BIG = 1024;
  const big = new Uint8Array(BIG * BIG).fill(255);
  for (let y = 200; y < 296; y++) for (let x = 200; x < 296; x++) big[y * BIG + x] = 0;
  const r = measureSolidFill(big, BIG, BIG);
  assert.equal(r.blockPx, 8, 'block edge tracks the short side');
  assert.ok(Math.abs(r.solidBlob - small.solidBlob) < 0.0005, `${r.solidBlob} vs ${small.solidBlob}`);
});

test('bad dimensions measure as no fill rather than throwing', () => {
  assert.deepEqual(measureSolidFill(new Uint8Array(0), 0, 0), { solidFill: 0, solidBlob: 0, blockPx: 0, blocks: 0 });
  assert.equal(measureSolidFill(new Uint8Array(10), 100, 100).solidFill, 0);
});

test('empty SVG is flagged', () => {
  assert.equal(assessColoringSvg('').verdict, 'flagged');
  assert.equal(assessColoringSvg('   ').reason, 'empty-svg');
});

test('SVG without drawing elements is flagged', () => {
  const r = assessColoringSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.equal(r.verdict, 'flagged');
  assert.equal(r.reason, 'no-paths');
});

test('SVG with a path passes', () => {
  const r = assessColoringSvg('<svg><path d="M0 0 L10 10"/></svg>');
  assert.equal(r.verdict, 'ok');
});
