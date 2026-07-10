import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, svgBox, clampCrop, EditError } from '../src/editor.js';

const PAGE = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0.00 0.00 1472.00 1088.00">
<g stroke-width="2.00" fill="none" stroke-linecap="butt">
<path fill="#010101" d="M 10 10 L 20 20 Z"/>
</g>
</svg>`;

test('the page coordinate system comes from the viewBox', () => {
  assert.deepEqual(svgBox(PAGE), { x: 0, y: 0, w: 1472, h: 1088 });
});

test('a page with only width and height still has a coordinate system', () => {
  assert.deepEqual(svgBox('<svg width="800" height="600"></svg>'), { x: 0, y: 0, w: 800, h: 600 });
});

test('a page with neither is refused rather than guessed at', () => {
  assert.throws(() => svgBox('<svg xmlns="x"></svg>'), EditError);
  assert.throws(() => svgBox('not an svg at all'), EditError);
});

test('the white pencil becomes a white path over the line art', () => {
  const out = applyEdits(PAGE, { strokes: [{ width: 24, points: [[10, 10], [20, 30]] }] });
  assert.match(out, /<g class="fma-edit"[^>]*stroke="#FFFFFF"/);
  assert.match(out, /<path stroke-width="24" d="M 10 10 L 20 30"\/>/);
  assert.ok(out.indexOf('fma-edit') < out.lastIndexOf('</svg>'), 'inside the document');
  assert.ok(out.indexOf('fma-edit') > out.indexOf('#010101'), 'and painted over the line art, not under it');
});

test('the pencil paints in its own group, so the root fill="none" cannot make it invisible', () => {
  const out = applyEdits(PAGE, { strokes: [{ width: 4, points: [[1, 1], [2, 2]] }] });
  assert.match(out, /<g class="fma-edit" fill="none" stroke="#FFFFFF"/);
});

test('a single click is a dot, not an empty path', () => {
  const out = applyEdits(PAGE, { strokes: [{ width: 9, points: [[5, 6]] }] });
  assert.match(out, /d="M 5 6 L 5 6"/, 'a zero-length line with a round cap draws a dot');
});

test('cropping re-frames the page and leaves the strokes where they were drawn', () => {
  const out = applyEdits(PAGE, {
    strokes: [{ width: 10, points: [[700, 500]] }],
    crop: { x: 100, y: 50, w: 800, h: 600 },
  });
  assert.deepEqual(svgBox(out), { x: 100, y: 50, w: 800, h: 600 });
  assert.match(out, /d="M 700 500/, 'the stroke keeps its original coordinates');
});

test('a crop is pinned inside the page it was dragged on', () => {
  const box = { x: 0, y: 0, w: 100, h: 100 };
  assert.deepEqual(clampCrop({ x: -50, y: -50, w: 500, h: 500 }, box), { x: 0, y: 0, w: 100, h: 100 });
  assert.deepEqual(clampCrop({ x: 90, y: 90, w: 50, h: 50 }, box), { x: 90, y: 90, w: 10, h: 10 });
});

test('a crop smaller than a page is a misclick, and is refused', () => {
  assert.throws(() => clampCrop({ x: 0, y: 0, w: 2, h: 900 }, { x: 0, y: 0, w: 1000, h: 1000 }), EditError);
});

test('width and height are only rewritten when the page had them', () => {
  assert.doesNotMatch(applyEdits(PAGE, { crop: { x: 0, y: 0, w: 10, h: 10 } }), /\swidth=/);
  const sized = '<svg width="1472" height="1088" viewBox="0 0 1472 1088"></svg>';
  const out = applyEdits(sized, { crop: { x: 0, y: 0, w: 800, h: 600 } });
  assert.match(out, /width="800"/);
  assert.match(out, /height="600"/, 'a size that disagrees with the viewBox squashes the page');
});

test('nonsense from the browser never reaches the customer\'s book', () => {
  assert.throws(() => applyEdits(PAGE, { strokes: [{ width: NaN, points: [[1, 1]] }] }), EditError);
  assert.throws(() => applyEdits(PAGE, { strokes: [{ width: 0, points: [[1, 1]] }] }), EditError);
  assert.throws(() => applyEdits(PAGE, { strokes: [{ width: 5, points: [['x', 1]] }] }), EditError);
  assert.throws(() => applyEdits(PAGE, { crop: { x: 0, y: 0, w: 'wide', h: 10 } }), EditError);
  assert.throws(() => applyEdits(PAGE, {}), EditError, 'saving nothing is a mistake, not a no-op');
});

test('an absurd number of strokes is refused rather than written', () => {
  const many = Array.from({ length: 2001 }, () => ({ width: 1, points: [[0, 0]] }));
  assert.throws(() => applyEdits(PAGE, { strokes: many }), EditError);
});

test('a page with no closing tag is refused', () => {
  assert.throws(() => applyEdits('<svg viewBox="0 0 10 10">', { strokes: [{ width: 1, points: [[1, 1]] }] }), EditError);
});
