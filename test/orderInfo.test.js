import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOrderInfo, shopDedication, resolveFormat, resolveLanguage, ORDER_INFO } from '../src/orderInfo.js';

const fixture = () => mkdtempSync(join(tmpdir(), 'fma-info-'));
const write = (dir, contents) => writeFileSync(join(dir, ORDER_INFO), typeof contents === 'string' ? contents : JSON.stringify(contents));

test('the shop\'s own spelling reaches the title page with its accents', () => {
  const dir = fixture();
  try {
    write(dir, { order: '1366', dedication: 'Pro Jiříčka', photos: ['1366_img0001 - pro jiříčka.jpg'] });
    assert.equal(shopDedication(dir), 'Pro Jiříčka');
    assert.deepEqual(readOrderInfo(dir), {
      order: '1366',
      dedication: 'Pro Jiříčka',
      expectedPhotos: null,
      // No purchase block: an older download reads as a lone single-copy book, which is what it was.
      purchase: { orderId: '1366', position: 1, of: 1 },
      copies: 1,
      customer: null,
      products: [],
      // Nor any attribution: null, not an unknown-channel object. An order downloaded before the
      // field existed has no RECORD of a source, which is a different fact from a shop that was
      // asked and had nothing to say — and the only one of the two that can still be filled in.
      attribution: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('"nobody asked" and "we asked and the shop had nothing" are different answers', () => {
  // Both display as "bez zdroje", which is why the distinction is easy to lose — and losing it is
  // what left the backfill button on screen forever, offering work that could never complete.
  // Only the first can still be filled in.
  const dir = fixture();
  try {
    write(dir, { order: '1601' });
    assert.equal(readOrderInfo(dir).attribution, null, 'no record: the backfill has something to do here');

    write(dir, { order: '1601', attribution: { source: null, medium: null, campaign: null, channel: 'unknown' } });
    assert.deepEqual(
      readOrderInfo(dir).attribution,
      { source: null, medium: null, campaign: null, channel: 'unknown' },
      'a record saying "unknown": the shop was asked and had nothing, and running it again will not help',
    );
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
    assert.deepEqual(readOrderInfo(dir), { order: '1479', dedication: '', expectedPhotos: null, purchase: { orderId: '1479', position: 1, of: 1 }, copies: 1, customer: null, products: [], attribution: null });

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

test('the expected photo count and customer are read when a newer extension wrote them', () => {
  const dir = fixture();
  try {
    write(dir, { order: '1523', dedication: 'Pro Aničku', expectedPhotos: 8, customer: { surname: 'Hofbauer', email: 'h@example.cz' } });
    const info = readOrderInfo(dir);
    assert.equal(info.expectedPhotos, 8);
    assert.deepEqual(info.customer, { surname: 'Hofbauer', email: 'h@example.cz' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bad expected count or customer is dropped, not trusted', () => {
  const dir = fixture();
  try {
    write(dir, { order: '1', expectedPhotos: 0, customer: 'Hofbauer' });
    let info = readOrderInfo(dir);
    assert.equal(info.expectedPhotos, null, 'zero is not a real count');
    assert.equal(info.customer, null, 'a string is not a customer object');

    write(dir, { order: '1', expectedPhotos: 4.5, customer: { surname: 42 } });
    info = readOrderInfo(dir);
    assert.equal(info.expectedPhotos, null, 'a non-integer count is dropped');
    assert.equal(info.customer, null, 'a customer with no usable fields is dropped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- line items + per-order build format (U9) -------------------------------

test('line items are read when the extension recorded them, and malformed ones dropped', () => {
  const dir = fixture();
  try {
    write(dir, {
      order: '1523',
      products: [
        { title: 'Fotomalovánky 8 fotek', variant: 'celostránkové', qty: 1 },
        { title: '', variant: '', qty: 2 }, // nothing to key a format off — dropped
        'not-an-object',
        { title: 'Pastelky', qty: 0 }, // a real product, no usable qty -> qty null, still kept
      ],
    });
    assert.deepEqual(readOrderInfo(dir).products, [
      { title: 'Fotomalovánky 8 fotek', variant: 'celostránkové', qty: 1 },
      { title: 'Pastelky', variant: '', qty: null },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an order with no line items reads an empty product list, never a crash', () => {
  const dir = fixture();
  try {
    write(dir, { order: '1', dedication: 'x' });
    assert.deepEqual(readOrderInfo(dir).products, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveFormat maps a variant to its layout and marks it mapped', () => {
  const config = { delivery: { format: 'gallery', formatMap: { celostránkové: 'fullpage' } } };
  const info = { products: [{ title: 'Fotomalovánky 8 fotek', variant: 'celostránkové', qty: 1 }] };
  assert.deepEqual(resolveFormat(info, config), { mode: 'fullpage', mapped: true });
});

test('resolveFormat matches on the product title when the variant is not keyed', () => {
  const config = { delivery: { format: 'gallery', formatMap: { 'Fotomalovánky celostránkové': 'fullpage' } } };
  const info = { products: [{ title: 'Fotomalovánky celostránkové', variant: '', qty: 1 }] };
  assert.deepEqual(resolveFormat(info, config), { mode: 'fullpage', mapped: true });
});

test('an unmapped variant falls back to the configured default and is flagged for override', () => {
  const config = { delivery: { format: 'gallery', formatMap: { celostránkové: 'fullpage' } } };
  const info = { products: [{ title: 'Fotomalovánky 4 fotky', variant: 'galerie 4', qty: 1 }] };
  assert.deepEqual(resolveFormat(info, config), { mode: 'gallery', mapped: false });
});

test('a galerie order and a full-page order resolve independently — no config change between them', () => {
  const config = { delivery: { format: 'gallery', formatMap: { celo: 'fullpage', gal: 'gallery' } } };
  const galerie = { products: [{ variant: 'gal' }] };
  const fullpage = { products: [{ variant: 'celo' }] };
  assert.equal(resolveFormat(galerie, config).mode, 'gallery');
  assert.equal(resolveFormat(fullpage, config).mode, 'fullpage');
});

test('with no delivery config, resolveFormat falls back to the global builder mode (no regression)', () => {
  assert.deepEqual(resolveFormat({ products: [{ variant: 'x' }] }, { builder: { pdf: { mode: 'fullpage' } } }), {
    mode: 'fullpage',
    mapped: false,
  });
  // No delivery block and no builder mode at all -> the historical default.
  assert.deepEqual(resolveFormat(null, {}), { mode: 'gallery', mapped: false });
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

test('a book of a multi-book purchase carries its position and copy count', () => {
  const dir = fixture();
  try {
    write(dir, { order: '1234-2', dedication: 'Pro Kevina', purchase: { orderId: '1234', position: 2, of: 2 }, copies: 3 });
    const info = readOrderInfo(dir);
    assert.deepEqual(info.purchase, { orderId: '1234', position: 2, of: 2 });
    assert.equal(info.copies, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a nonsensical purchase block reads as a lone book rather than inventing a sibling', () => {
  const dir = fixture();
  try {
    // position past the total: the two values contradict each other, so trust neither.
    write(dir, { order: '1300', purchase: { orderId: '1300', position: 3, of: 2 } });
    assert.deepEqual(readOrderInfo(dir).purchase, { orderId: '1300', position: 1, of: 1 });

    write(dir, { order: '1300', purchase: 'the second one', copies: -4 });
    const info = readOrderInfo(dir);
    assert.deepEqual(info.purchase, { orderId: '1300', position: 1, of: 1 }, 'a purchase of the wrong type is no answer');
    assert.equal(info.copies, 1, 'a nonsensical copy count still prints one book');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- output language (DE covers) --------------------------------------------

test('resolveLanguage maps a variant to its language and marks it mapped', () => {
  const config = { delivery: { language: 'cz', languageMap: { '🇩🇪 Malbuch aus Fotos': 'de' } } };
  const info = { products: [{ title: 'Malbuch', variant: '🇩🇪 Malbuch aus Fotos', qty: 1 }] };
  assert.deepEqual(resolveLanguage(info, config), { language: 'de', mapped: true });
});

test('resolveLanguage matches on the product title when the variant is not keyed', () => {
  const config = { delivery: { languageMap: { 'Malbuch aus Fotos': 'de' } } };
  const info = { products: [{ title: 'Malbuch aus Fotos', variant: '', qty: 1 }] };
  assert.deepEqual(resolveLanguage(info, config), { language: 'de', mapped: true });
});

test('an unmapped product falls back to Czech and is flagged, never silently German', () => {
  const config = { delivery: { language: 'cz', languageMap: { 'Malbuch aus Fotos': 'de' } } };
  const info = { products: [{ title: 'Fotomalovánky 4 fotky', variant: 'galerie 4', qty: 1 }] };
  assert.deepEqual(resolveLanguage(info, config), { language: 'cz', mapped: false });
});

test('a Czech order and a German order resolve independently — no config edit between them', () => {
  const config = { delivery: { language: 'cz', languageMap: { de: 'de', cz: 'cz' } } };
  assert.equal(resolveLanguage({ products: [{ variant: 'de' }] }, config).language, 'de');
  assert.equal(resolveLanguage({ products: [{ variant: 'cz' }] }, config).language, 'cz');
});

test('with no language config at all, an order is Czech — the shipped behaviour before DE existed', () => {
  assert.deepEqual(resolveLanguage({ products: [{ variant: 'x' }] }, {}), { language: 'cz', mapped: false });
  assert.deepEqual(resolveLanguage(null, {}), { language: 'cz', mapped: false });
  // A configured default is honoured for everything unmapped.
  assert.deepEqual(resolveLanguage(null, { builder: { pdf: { language: 'de' } } }), { language: 'de', mapped: false });
});

test('a typo in the language map is carried through, so the builder driver can refuse it loudly', () => {
  const config = { delivery: { languageMap: { 'Malbuch': 'german' } } };
  assert.deepEqual(resolveLanguage({ products: [{ title: 'Malbuch' }] }, config), { language: 'german', mapped: true });
});
