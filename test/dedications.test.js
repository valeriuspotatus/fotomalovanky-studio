import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDedications, learnDedication, recallDedication, dedicationsPath, migrateDedications, MEMORY_DIR } from '../src/dedications.js';
import { slugFromBase, deriveSlug, dedicationFromBase } from '../src/dedication.js';

const root = () => mkdtempSync(join(tmpdir(), 'fma-ded-'));

test('the slug is the file name suffix, lowercased and otherwise untouched', () => {
  assert.equal(slugFromBase('1366_img0001_-_pro_jiricka'), 'pro_jiricka');
  assert.equal(slugFromBase('1523_img0001_-_Hofbauerovi_18.7.2026'), 'hofbauerovi_18.7.2026');
  assert.equal(slugFromBase('1515_img0001_-_julka__agnes'), 'julka__agnes', 'the doubled underscore is a "+", and survives');
  assert.equal(slugFromBase('1479_img0001'), '', 'a customer who wrote nothing has no slug');
});

test('every photo of an order votes on the slug', () => {
  assert.equal(deriveSlug(['1366_img0001_-_pro_jiricka', '1366_img0002_-_pro_jiricka', '1366_img0003_-_stray']), 'pro_jiricka');
  assert.equal(deriveSlug([]), '');
});

test('nothing is remembered until the operator says something', () => {
  const dir = root();
  try {
    assert.deepEqual(readDedications(dir), {});
    assert.equal(recallDedication(dir, 'pro_jiricka'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the accents the shop threw away are learned once and recalled forever', () => {
  const dir = root();
  try {
    // This is the whole point: the file name cannot say which "jiricka" the customer meant.
    assert.equal(dedicationFromBase('1366_img0001_-_pro_jiricka'), 'Pro Jiricka');

    learnDedication(dir, 'pro_jiricka', 'Pro Jiříčka');
    assert.equal(recallDedication(dir, 'pro_jiricka'), 'Pro Jiříčka');
    assert.ok(existsSync(dedicationsPath(dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrected spelling replaces the old one', () => {
  const dir = root();
  try {
    learnDedication(dir, 'pro_jiricka', 'Pro Jiřička');
    learnDedication(dir, 'pro_jiricka', 'Pro Jiříčka'); // the operator noticed and fixed it
    assert.equal(recallDedication(dir, 'pro_jiricka'), 'Pro Jiříčka');
    assert.equal(Object.keys(readDedications(dir)).length, 1, 'one entry, not two');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('emptying one order\'s title does not teach every future order to be untitled', () => {
  const dir = root();
  try {
    learnDedication(dir, 'pro_jiricka', 'Pro Jiříčka');
    learnDedication(dir, 'pro_jiricka', ''); // "this book has no title page"
    assert.equal(recallDedication(dir, 'pro_jiricka'), '', 'the slug is forgotten, not remembered as empty');
    assert.deepEqual(readDedications(dir), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an order with no slug teaches nothing', () => {
  const dir = root();
  try {
    learnDedication(dir, '', 'Pro Jiříčka');
    assert.deepEqual(readDedications(dir), {});
    assert.ok(!existsSync(dedicationsPath(dir)), 'and writes no file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt memory file loses the spellings, never the ability to print', () => {
  const dir = root();
  try {
    writeFileSync(dedicationsPath(dir), '{ this is not json');
    assert.deepEqual(readDedications(dir), {});
    assert.equal(recallDedication(dir, 'pro_jiricka'), '');

    learnDedication(dir, 'pro_jiricka', 'Pro Jiříčka'); // and it heals on the next correction
    assert.equal(recallDedication(dir, 'pro_jiricka'), 'Pro Jiříčka');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the memory lives with the tool, not in the outbox that gets emptied', () => {
  assert.ok(!dedicationsPath().includes('outbox'), 'never in the outbox');
  assert.equal(dedicationsPath(MEMORY_DIR), join(MEMORY_DIR, 'dedications.json'));
  assert.ok(existsSync(join(MEMORY_DIR, 'package.json')), 'MEMORY_DIR is the tool folder, beside config.json');
});

test('a memory left in the old place is carried across, not abandoned', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-mig-'));
  const outbox = join(root, 'outbox');
  const home = join(root, 'home');
  mkdirSync(outbox, { recursive: true });
  mkdirSync(home, { recursive: true });
  try {
    writeFileSync(join(outbox, '.dedications.json'), JSON.stringify({ pro_jiricka: 'Pro Jiříčka' }));

    const moved = migrateDedications(outbox, home);
    assert.deepEqual(moved, ['pro_jiricka']);
    assert.equal(recallDedication(home, 'pro_jiricka'), 'Pro Jiříčka');
    assert.ok(!existsSync(join(outbox, '.dedications.json')), 'one home, so the next correction cannot land in the wrong one');

    assert.deepEqual(migrateDedications(outbox, home), [], 'and it is a no-op the second time');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migrating never overwrites a spelling already taught in the new place', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-mig2-'));
  const outbox = join(root, 'outbox');
  const home = join(root, 'home');
  mkdirSync(outbox, { recursive: true });
  mkdirSync(home, { recursive: true });
  try {
    writeFileSync(join(outbox, '.dedications.json'), JSON.stringify({ pro_jiricka: 'Pro Jiricka' })); // the old, wrong one
    learnDedication(home, 'pro_jiricka', 'Pro Jiříčka'); // the correction they have since made

    migrateDedications(outbox, home);
    assert.equal(recallDedication(home, 'pro_jiricka'), 'Pro Jiříčka', 'the newer answer wins');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('junk entries are ignored rather than printed onto a title page', () => {
  const dir = root();
  try {
    writeFileSync(dedicationsPath(dir), JSON.stringify({ good: 'Pro Jiříčka', bad: 42, worse: { a: 1 } }));
    assert.deepEqual(readDedications(dir), { good: 'Pro Jiříčka' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
