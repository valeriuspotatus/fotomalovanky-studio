import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedicationFromBase, deriveDedication } from '../src/dedication.js';

test('the real order names yield the text the operator would have typed', () => {
  assert.equal(dedicationFromBase('1523_img0001_-_hofbauerovi_18.7.2026'), 'Hofbauerovi 18.7.2026');
  assert.equal(dedicationFromBase('1521_img0001_-_pro_maxinnku_a_estellku'), 'Pro Maxinnku a Estellku');
});

test('Czech function words stay lowercase, but never the first one', () => {
  assert.equal(dedicationFromBase('1_img1_-_pro_evu_a_adama'), 'Pro Evu a Adama');
  assert.equal(dedicationFromBase('1_img1_-_s_laskou_od_babicky'), 'S Laskou od Babicky');
  assert.equal(dedicationFromBase('1_img1_-_a'), 'A', 'a single function word is still the first word');
});

test('spelling is copied exactly — a customer typo is theirs, not ours to fix', () => {
  // "maxinnku" has a doubled n. It survives; only the case and the underscores change.
  assert.equal(dedicationFromBase('1_img1_-_maxinnku'), 'Maxinnku');
  assert.equal(dedicationFromBase('1_img1_-_ESTELLKA'), 'ESTELLKA');
});

test('a word starting with a digit is left alone', () => {
  assert.equal(dedicationFromBase('1_img1_-_18.7.2026'), '18.7.2026');
});

test('diacritics survive the capitalisation', () => {
  assert.equal(dedicationFromBase('1_img1_-_čeněk_a_řehoř'), 'Čeněk a Řehoř');
});

test('a name with no dedication segment yields none — that customer wrote nothing', () => {
  assert.equal(dedicationFromBase('1500_img0001'), '');
  assert.equal(dedicationFromBase('a'), '');
  assert.equal(dedicationFromBase('1499_img0001_-_'), '', 'an empty segment is still nothing');
  assert.equal(dedicationFromBase(undefined), '');
});

test('a generic photo label after the separator is "no dedication", not a title (order 1527 bug)', () => {
  // The customer wrote nothing; the shop filled the field with a placeholder like "foto". Printing
  // the word "Foto" on the cover is wrong — it must read as blank, same as an absent segment.
  assert.equal(dedicationFromBase('1527_img0001_-_foto'), '');
  assert.equal(dedicationFromBase('1527_img0001 - foto'), '', 'newer name format too');
  assert.equal(dedicationFromBase('1527_img0001_-_foto_2'), '', 'foto + a number is still just the label');
  assert.equal(dedicationFromBase('1_img1_-_FOTOGRAFIE'), '', 'case + word variants fold to the same placeholder');
  assert.equal(dedicationFromBase('1_img1_-_photo'), '');
  assert.equal(dedicationFromBase('1_img1_-_img'), '');
  // A real dedication that merely contains such a word keeps its other words.
  assert.equal(dedicationFromBase('1_img1_-_foto_novakove'), 'Foto Novakove');
  // The whole order of placeholder-named photos derives no title.
  assert.equal(deriveDedication(['1527_img0001_-_foto', '1527_img0002_-_foto', '1527_img0003_-_foto']), '');
});

test('a doubled underscore is the "+" the shop stripped out of the name', () => {
  assert.equal(dedicationFromBase('1515_img0001_-_julka__agnes__honzik'), 'Julka + Agnes + Honzik');
  assert.equal(dedicationFromBase('1_img1_-_eva__adam'), 'Eva + Adam');
  assert.equal(dedicationFromBase('1_img1_-_pro_evu__adama'), 'Pro Evu + Adama');
});

test('a stray run of underscores never becomes an empty word or a leading "+"', () => {
  assert.equal(dedicationFromBase('1_img1_-___eva___'), 'Eva');
  assert.equal(dedicationFromBase('1_img1_-_eva___adam'), 'Eva + Adam', 'three underscores are still one "+"');
});

test('an order takes the text its photos agree on', () => {
  const bases = ['1523_img0001_-_hofbauerovi', '1523_img0002_-_hofbauerovi', '1523_img0003_-_hofbauerovi'];
  assert.equal(deriveDedication(bases), 'Hofbauerovi');
});

test('one oddly named photo does not decide the whole book — the majority does', () => {
  const bases = ['1521_img0001_-_pro_evu', '1521_img0002_-_pro_evu', '1521_img0003_-_scan_copy'];
  assert.equal(deriveDedication(bases), 'Pro Evu');
});

test('an order whose photos carry no text derives nothing', () => {
  assert.equal(deriveDedication(['a', 'b']), '');
  assert.equal(deriveDedication([]), '');
});
