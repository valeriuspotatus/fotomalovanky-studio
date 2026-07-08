import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPairs } from '../src/builder/builderDriver.js';

/** Build a throwaway order folder containing exactly `names`. */
function orderDir(names) {
  const dir = mkdtempSync(join(tmpdir(), 'fma-pairs-'));
  for (const n of names) writeFileSync(join(dir, n), '');
  return dir;
}

test('pairs a .jpg original with its .svg coloring page', () => {
  const dir = orderDir(['1522_img0001.jpg', '1522_img0001.svg', '1522_img0001_bw.png']);
  const pairs = collectPairs(dir);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0], { base: '1522_img0001', photo: '1522_img0001.jpg', svg: '1522_img0001.svg' });
});

test('pairs a .png original — the fixture pack orders are PNG throughout', () => {
  const dir = orderDir(['fam.png', 'fam.svg', 'fam_bw.png']);
  const pairs = collectPairs(dir);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].photo, 'fam.png');
  assert.equal(pairs[0].svg, 'fam.svg');
});

test('never treats "<base>_bw.png" as an input photo', () => {
  // Without the _bw skip this yields a bogus pair keyed "fam_bw" as soon as PNG is allowed.
  const dir = orderDir(['fam.png', 'fam.svg', 'fam_bw.png', 'fam_bw.svg']);
  const pairs = collectPairs(dir);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].photo, 'fam.png');
  assert.ok(!pairs.some((p) => p.base.endsWith('_bw')));
});

test('an original with no SVG is not a pair, and vice versa', () => {
  const dir = orderDir(['lonely.jpg', 'orphan.svg', 'ok.png', 'ok.svg']);
  const pairs = collectPairs(dir);
  assert.deepEqual(pairs.map((p) => p.base), ['ok']);
});

test('a .jpeg original pairs on its stem', () => {
  const dir = orderDir(['photo.jpeg', 'photo.svg']);
  assert.equal(collectPairs(dir)[0].photo, 'photo.jpeg');
});

test('six PNG originals reproduce the AI Family pair count (N=6 -> 16pg gallery)', () => {
  const names = [];
  for (let i = 1; i <= 6; i++) names.push(`p${i}.png`, `p${i}.svg`, `p${i}_bw.png`);
  assert.equal(collectPairs(orderDir(names)).length, 6);
});
