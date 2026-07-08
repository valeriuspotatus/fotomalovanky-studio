import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPhoto, photoBase, outputNames, outputPaths } from '../src/organize.js';

test('isPhoto matches jpg/jpeg case-insensitively and rejects others', () => {
  assert.ok(isPhoto('a.jpg'));
  assert.ok(isPhoto('a.JPEG'));
  assert.ok(!isPhoto('a.png'));
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
