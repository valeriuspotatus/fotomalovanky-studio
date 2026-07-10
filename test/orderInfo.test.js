import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOrderInfo, shopDedication, ORDER_INFO } from '../src/orderInfo.js';

const fixture = () => mkdtempSync(join(tmpdir(), 'fma-info-'));
const write = (dir, contents) => writeFileSync(join(dir, ORDER_INFO), typeof contents === 'string' ? contents : JSON.stringify(contents));

test('the shop\'s own spelling reaches the title page with its accents', () => {
  const dir = fixture();
  try {
    write(dir, { order: '1366', dedication: 'Pro Jiříčka', photos: ['1366_img0001 - pro jiříčka.jpg'] });
    assert.equal(shopDedication(dir), 'Pro Jiříčka');
    assert.deepEqual(readOrderInfo(dir), { order: '1366', dedication: 'Pro Jiříčka' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an order downloaded before the extension wrote one is simply unanswered', () => {
  const dir = fixture();
  try {
    assert.equal(readOrderInfo(dir), null);
    assert.equal(shopDedication(dir), '', 'not an error — the file names still have something to say');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a half-written or hand-mangled file never stops a book being printed', () => {
  const dir = fixture();
  try {
    write(dir, '{"dedication": "Pro Klárku"'); // the browser was closed mid-download
    assert.equal(readOrderInfo(dir), null);
    assert.equal(shopDedication(dir), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dedication of the wrong type is not printed onto a title page', () => {
  const dir = fixture();
  try {
    write(dir, { order: '1366', dedication: { text: 'Pro Klárku' } });
    assert.equal(shopDedication(dir), '');

    write(dir, [1, 2, 3]);
    assert.equal(readOrderInfo(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a customer who wrote nothing said nothing', () => {
  const dir = fixture();
  try {
    write(dir, { order: '1479', dedication: '' });
    assert.equal(shopDedication(dir), '');
    assert.deepEqual(readOrderInfo(dir), { order: '1479', dedication: '' });

    write(dir, { order: '1479', dedication: '   ' });
    assert.equal(shopDedication(dir), '', 'whitespace is not a dedication');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing folder is not a crash', () => {
  assert.equal(readOrderInfo(null), null);
  assert.equal(shopDedication(join(tmpdir(), 'fma-not-here-at-all')), '');
});

test('the file sits inside the order folder, beside the photographs', () => {
  const dir = fixture();
  try {
    mkdirSync(join(dir, 'nested'), { recursive: true });
    write(join(dir, 'nested'), { dedication: 'Pro Vanesku' });
    assert.equal(shopDedication(dir), '', 'it is not looked for anywhere else');
    assert.equal(shopDedication(join(dir, 'nested')), 'Pro Vanesku');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
