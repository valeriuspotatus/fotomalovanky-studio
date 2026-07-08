import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessColoringPixels, assessColoringSvg } from '../src/qc.js';

const solid = (value, n = 1000) => new Uint8Array(n).fill(value);

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
