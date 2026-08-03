import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPairs, coverCountFor, coverVariantFor, languageFor } from '../src/builder/builderDriver.js';

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

// ---- the title-page collage -------------------------------------------------
// The operator's books show four thumbnails. The builder's "add all" button always selects
// eight, so the driver clicks tiles instead and needs to know how many.

test('coverCount picks how many thumbnails the title page gets', () => {
  assert.equal(coverCountFor({ coverCount: 4 }, 8), 4);
  assert.equal(coverCountFor({ coverCount: 0 }, 8), 0);
  assert.equal(coverCountFor({}, 8), 0, 'no covers unless asked for');
});

test('coverCount never exceeds the pairs on hand or the builder cap of 8', () => {
  assert.equal(coverCountFor({ coverCount: 4 }, 2), 2, 'a two-photo order cannot show four');
  assert.equal(coverCountFor({ coverCount: 99 }, 12), 8, 'the builder itself caps at 8');
  assert.equal(coverCountFor({ coverCount: -1 }, 8), 0);
});

test('addAllCovers still means eight, and coverCount overrides it', () => {
  assert.equal(coverCountFor({ addAllCovers: true }, 8), 8);
  assert.equal(coverCountFor({ addAllCovers: true }, 3), 3);
  assert.equal(coverCountFor({ addAllCovers: true, coverCount: 4 }, 8), 4);
});

// ---- the cover variant (classic | pencils) ---------------------------------
// The builder's title page has a plain "classic" cover and a decorated "pencils" cover. The driver
// only touches the control when a variant is named, and refuses an unknown one rather than silently
// shipping the plain cover.

test('coverVariant selects a named variant, case/space tolerant', () => {
  assert.equal(coverVariantFor({ coverVariant: 'pencils' }), 'pencils');
  assert.equal(coverVariantFor({ coverVariant: 'classic' }), 'classic');
  assert.equal(coverVariantFor({ coverVariant: '  Pencils ' }), 'pencils');
});

test('coverVariant is null when unset — leave the builder default untouched', () => {
  assert.equal(coverVariantFor({}), null);
  assert.equal(coverVariantFor({ coverVariant: null }), null);
  assert.equal(coverVariantFor({ coverVariant: '' }), null);
  assert.equal(coverVariantFor(), null);
});

test('an unknown cover variant throws rather than silently printing classic', () => {
  // The exact bug class we are guarding: "pencil" (singular) must not quietly become classic.
  assert.throws(() => coverVariantFor({ coverVariant: 'pencil' }), /Unknown cover variant/);
  assert.throws(() => coverVariantFor({ coverVariant: 'fancy' }), /Unknown cover variant/);
});

// ---- output language (cz|de) -------------------------------------------------

test('languageFor normalizes a named language and leaves the builder default alone when unset', () => {
  assert.equal(languageFor({ language: 'de' }), 'de');
  assert.equal(languageFor({ language: 'cz' }), 'cz');
  assert.equal(languageFor({ language: '  DE ' }), 'de');
  assert.equal(languageFor({}), null, 'unset means do not touch the control');
  assert.equal(languageFor({ language: '' }), null);
  assert.equal(languageFor(), null);
});

test('an unknown language throws rather than quietly printing a Czech book for a German customer', () => {
  assert.throws(() => languageFor({ language: 'german' }), /Unknown output language/);
  assert.throws(() => languageFor({ language: 'en' }), /Unknown output language/);
});
