import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { materializeOrder } from '../src/shopify/materialize.js';
import { isPhoto } from '../src/organize.js';
import { readOrderInfo } from '../src/orderInfo.js';
import { sourceFingerprint } from '../src/shopify/orders.js';
import { acquireOrderLock, OrderLockedError } from '../src/orderLock.js';

// The upload host serves some photos as PNG/WebP, but organize.js only ingests .jpg/.jpeg — so an
// order like #1525 downloaded as PNG would land in the folder yet be silently skipped by the
// pipeline. materializeOrder must re-encode non-JPEG photos so every one reaches ingest.

const ORDER = { orderId: '9001', dedication: 'Pro Aničku', email: 'x@y.cz', layout: null, products: [], photos: [] };
const swatch = (bg) => sharp({ create: { width: 4, height: 4, channels: 3, background: bg } });

test('materialization fails before writing when the logical order is locked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-mat-lock-'));
  const release = acquireOrderLock({ inboxRoot: root, orderId: ORDER.orderId, operation: 'pipeline' });
  try {
    await assert.rejects(() => materializeOrder(ORDER, { inboxRoot: root }), OrderLockedError);
    assert.equal(existsSync(join(root, ORDER.orderId)), false);
  } finally { release(); rmSync(root, { recursive: true, force: true }); }
});

test('materializeOrder re-encodes a non-JPEG photo to JPEG so the pipeline ingests it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-mat-'));
  try {
    const png = await swatch('#abcdef').png().toBuffer();
    const jpg = await swatch('#abcdef').jpeg().toBuffer();
    const safeFetch = async (url) => (url.endsWith('.png') ? { buffer: png, ext: 'png' } : { buffer: jpg, ext: 'jpg' });
    const order = { ...ORDER, photos: ['https://cdn.example/one.png', 'https://cdn.example/two.jpg'] };

    const res = await materializeOrder(order, { inboxRoot: root, safeFetch });
    assert.equal(res.incomplete, false);
    assert.equal(res.files.length, 2);
    assert.ok(res.files.every(isPhoto), `every written photo is ingestable: ${res.files.join(', ')}`);

    const converted = res.files.find((f) => f.endsWith('.jpeg'));
    assert.ok(converted, 'the PNG was written as a .jpeg');
    const meta = await sharp(readFileSync(join(root, order.orderId, converted))).metadata();
    assert.equal(meta.format, 'jpeg', 'the re-encoded bytes are really JPEG');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('materializeOrder leaves an already-JPEG photo untouched (no needless re-encode)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-mat-'));
  try {
    const jpg = await swatch('#123456').jpeg().toBuffer();
    let reencodes = 0;
    const sharpImpl = (b) => { reencodes++; return sharp(b); };
    const safeFetch = async () => ({ buffer: jpg, ext: 'jpg' });

    const res = await materializeOrder({ ...ORDER, photos: ['https://cdn.example/a.jpg'] }, { inboxRoot: root, safeFetch, sharpImpl });
    assert.ok(res.files[0].endsWith('.jpg'), 'the .jpg extension is preserved');
    assert.equal(reencodes, 0, 'sharp is not invoked for a photo already in JPEG');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- one purchase, several books ---------------------------------------------------------------

const jpegFetch = async () => ({ buffer: await swatch('#123456').jpeg().toBuffer(), ext: 'jpg' });

/** One book of a two-book purchase, as extractJobs would hand it over. */
const book = (position, { photos, dedication, variant }) => ({
  orderId: `1234-${position}`,
  purchase: { orderId: '1234', position, of: 2 },
  copies: 1,
  dedication,
  email: 'x@y.cz',
  layout: null,
  products: [{ title: 'Fotomalovánky', variant, qty: 1 }],
  photos,
});

test('the two books of one purchase land in sibling folders, each holding only its own photos', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-mat-'));
  try {
    const a = await materializeOrder(book(1, { photos: ['https://cdn.example/a1.jpg', 'https://cdn.example/a2.jpg'], dedication: 'Pro Adélku', variant: 'Tištěné / 2' }), { inboxRoot: root, safeFetch: jpegFetch });
    const b = await materializeOrder(book(2, { photos: ['https://cdn.example/b1.jpg'], dedication: 'Pro Kevina', variant: 'Tištěné / 4' }), { inboxRoot: root, safeFetch: jpegFetch });

    assert.equal(a.orderDir, join(root, '1234-1'));
    assert.equal(b.orderDir, join(root, '1234-2'), 'two folders, not one merged');
    assert.equal(a.files.length, 2);
    assert.equal(b.files.length, 1, "the second book holds only its own photo");

    // Filenames carry the FULL job id, so ingest's filename consensus cannot re-merge the books.
    assert.ok(a.files.every((f) => f.startsWith('1234-1_img')), `first book's filenames carry its job id: ${a.files.join(', ')}`);
    assert.ok(b.files.every((f) => f.startsWith('1234-2_img')), `second book's filenames carry its job id: ${b.files.join(', ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each book's sidecar carries its own expected count, dedication and purchase position", async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-mat-'));
  try {
    await materializeOrder(book(1, { photos: ['https://cdn.example/a1.jpg'], dedication: 'Pro Adélku', variant: 'Tištěné / 8' }), { inboxRoot: root, safeFetch: jpegFetch });
    await materializeOrder(book(2, { photos: ['https://cdn.example/b1.jpg'], dedication: 'Pro Kevina', variant: 'Tištěné / 4' }), { inboxRoot: root, safeFetch: jpegFetch });

    const read = (id) => JSON.parse(readFileSync(join(root, id, 'objednavka.json'), 'utf8'));
    const one = read('1234-1');
    const two = read('1234-2');

    assert.equal(one.expectedPhotos, 8);
    assert.equal(two.expectedPhotos, 4, "the first line item's count no longer sets the second's");
    assert.equal(one.dedication, 'Pro Adélku');
    assert.equal(two.dedication, 'Pro Kevina');
    assert.deepEqual(one.purchase, { orderId: '1234', position: 1, of: 2 });
    assert.deepEqual(two.purchase, { orderId: '1234', position: 2, of: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a single-book order writes the bare number and reads as a lone book', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-mat-'));
  try {
    const res = await materializeOrder(
      { ...ORDER, orderId: '1524', purchase: { orderId: '1524', position: 1, of: 1 }, copies: 1, photos: ['https://cdn.example/a.jpg'] },
      { inboxRoot: root, safeFetch: jpegFetch },
    );
    assert.equal(res.orderDir, join(root, '1524'), 'no suffix — indistinguishable from before the split existed');
    assert.ok(res.files.every((f) => f.startsWith('1524_img')));
    const sidecar = JSON.parse(readFileSync(join(root, '1524', 'objednavka.json'), 'utf8'));
    assert.equal(sidecar.purchase.of, 1, 'a lone book, so nothing to link it to');
    assert.equal(sidecar.copies, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an order object with no purchase info still materializes, as a lone single-copy book', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-mat-'));
  try {
    // A hand-built order — a manual pull, or an older caller. It must not crash on the new fields.
    await materializeOrder({ ...ORDER, photos: ['https://cdn.example/a.jpg'] }, { inboxRoot: root, safeFetch: jpegFetch });
    const sidecar = JSON.parse(readFileSync(join(root, '9001', 'objednavka.json'), 'utf8'));
    assert.deepEqual(sidecar.purchase, { orderId: '9001', position: 1, of: 1 });
    assert.equal(sidecar.copies, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a photo that cannot be fetched marks only its own book incomplete', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-mat-'));
  try {
    const failing = async (url) => {
      if (url.includes('b1')) throw new Error('403 from the CDN');
      return { buffer: await swatch('#123456').jpeg().toBuffer(), ext: 'jpg' };
    };
    const a = await materializeOrder(book(1, { photos: ['https://cdn.example/a1.jpg'], dedication: 'A', variant: 'Tištěné / 1' }), { inboxRoot: root, safeFetch: failing });
    const b = await materializeOrder(book(2, { photos: ['https://cdn.example/b1.jpg'], dedication: 'B', variant: 'Tištěné / 1' }), { inboxRoot: root, safeFetch: failing });
    assert.equal(a.incomplete, false, 'the healthy book is unaffected by its sibling');
    assert.equal(b.incomplete, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the sidecar records where the order came from, and an order built by hand reads as unknown', async () => {
  // The board's "Zdroj" column is drawn from this, written once at download rather than re-pulled
  // per row. A manual pull or a test carries no attribution, and that is not an error.
  const root = mkdtempSync(join(tmpdir(), 'fma-mat-'));
  try {
    const sourced = await materializeOrder(
      { ...ORDER, orderId: '1701', photos: ['https://cdn.example/a.jpg'], attribution: { source: 'facebook', medium: 'paid', campaign: 'A+ sales - 3-2026' } },
      { inboxRoot: root, safeFetch: jpegFetch },
    );
    const sidecar = JSON.parse(readFileSync(join(sourced.orderDir, 'objednavka.json'), 'utf8'));
    assert.deepEqual(
      sidecar.attribution,
      { source: 'facebook', medium: 'paid', campaign: 'A+ sales - 3-2026', channel: 'paid' },
      'the channel is resolved once, here, so no consumer has to classify it again',
    );

    const byHand = await materializeOrder({ ...ORDER, orderId: '1702', photos: ['https://cdn.example/a.jpg'] }, { inboxRoot: root, safeFetch: jpegFetch });
    const plain = JSON.parse(readFileSync(join(byHand.orderDir, 'objednavka.json'), 'utf8'));
    assert.equal(plain.attribution, null);
    assert.equal(readOrderInfo(byHand.orderDir).attribution, null, 'and it reads back as no record — not as a crash, and not as a shop that answered');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a sidecar an operator hand-edited cannot inject a channel the dashboard does not know', () => {
  // The file sits on disk next to the photographs; somebody can open it. The channel is rebuilt
  // from the known set rather than trusted, so a stray value reads as unknown rather than becoming
  // a column heading nobody wrote.
  const root = mkdtempSync(join(tmpdir(), 'fma-mat-'));
  try {
    const dir = join(root, '1703');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'objednavka.json'), JSON.stringify({ order: '1703', attribution: { channel: '<script>', source: 'x'.repeat(500), campaign: 42 } }));
    const a = readOrderInfo(dir).attribution;
    assert.equal(a.channel, 'unknown');
    assert.equal(a.source.length, 120, 'and a runaway source is capped');
    assert.equal(a.campaign, null, 'a non-string campaign is dropped rather than coerced');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refreshes are transactional, exact, and clean up staging files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-mat-'));
  try {
    const first = { ...ORDER, photos: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'] };
    await materializeOrder(first, { inboxRoot: root, safeFetch: jpegFetch });
    const dir = join(root, ORDER.orderId);
    writeFileSync(join(dir, 'stale.jpg'), 'stale');
    const fewer = { ...first, photos: ['https://cdn.example/c.jpg'] };
    const refreshed = await materializeOrder(fewer, { inboxRoot: root, safeFetch: jpegFetch });
    assert.deepEqual(readdirSync(dir).sort(), ['objednavka.json', refreshed.files[0]].sort());
    assert.equal(readdirSync(root).some((name) => name.includes('.staging-') || name.includes('.previous-')), false);
    const before = readdirSync(dir).map((name) => [name, readFileSync(join(dir, name))]);
    const failed = await materializeOrder({ ...first, photos: ['https://cdn.example/new.jpg', 'https://cdn.example/fail.jpg'] }, { inboxRoot: root, safeFetch: async (url) => { if (url.includes('fail')) throw new Error('network down'); return jpegFetch(); } });
    assert.equal(failed.incomplete, true);
    assert.deepEqual(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name))]), before);
    assert.equal(readdirSync(root).some((name) => name.includes('.staging-') || name.includes('.previous-')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('conversion failure preserves the previous active folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-mat-'));
  try {
    await materializeOrder({ ...ORDER, photos: ['https://cdn.example/a.jpg'] }, { inboxRoot: root, safeFetch: jpegFetch });
    const before = readFileSync(join(root, ORDER.orderId, 'objednavka.json'), 'utf8');
    const failed = await materializeOrder({ ...ORDER, photos: ['https://cdn.example/a.png'] }, { inboxRoot: root, safeFetch: async () => ({ buffer: Buffer.from('bad'), ext: 'png' }) });
    assert.equal(failed.incomplete, true);
    assert.equal(readFileSync(join(root, ORDER.orderId, 'objednavka.json'), 'utf8'), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unsafe order ids are rejected before any path is created', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-mat-'));
  try {
    for (const orderId of ['../escape', '..\\escape', '9001/other', 'C:\\escape', '', '.']) await assert.rejects(() => materializeOrder({ ...ORDER, orderId, photos: ['https://cdn.example/a.jpg'] }, { inboxRoot: root, safeFetch: jpegFetch }), /safe order id/i);
    assert.deepEqual(readdirSync(root), []);
    assert.equal(existsSync(join(root, '..', 'escape')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('source fingerprint is deterministic, meaningful, and contains no source secrets', () => {
  const order = { ...ORDER, orderId: '42', updatedAt: 'one', photos: [' HTTPS://CDN.EXAMPLE/a.jpg '], dedication: '  Pro Ani  ', products: [{ title: ' Book ', variant: ' Print / 1 ', qty: 1 }], sourceAttributes: [{ key: 'Color', value: ' Blue ' }] };
  const a = sourceFingerprint(order);
  assert.equal(a, sourceFingerprint({ ...order, updatedAt: 'two' }));
  assert.match(a, /^sha256:[a-f0-9]{64}$/);
  assert.equal(a.includes('Pro Ani'), false);
  assert.notEqual(a, sourceFingerprint({ ...order, photos: ['https://cdn.example/b.jpg'] }));
  assert.notEqual(a, sourceFingerprint({ ...order, dedication: 'Pro Evu' }));
  assert.notEqual(a, sourceFingerprint({ ...order, sourceAttributes: [{ key: 'Color', value: 'Red' }] }));
});

test('first, same, more, and changed revisions each publish exactly the current source set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-mat-'));
  try {
    const revisions = [
      ['https://cdn.example/a.jpg'],
      ['https://cdn.example/a.jpg'],
      ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg', 'https://cdn.example/c.jpg'],
      ['https://cdn.example/d.jpg', 'https://cdn.example/e.jpg'],
    ];
    let previousFingerprint = null;
    for (let i = 0; i < revisions.length; i++) {
      const result = await materializeOrder({ ...ORDER, photos: revisions[i] }, { inboxRoot: root, safeFetch: jpegFetch });
      const names = readdirSync(result.orderDir);
      assert.equal(names.filter(isPhoto).length, revisions[i].length);
      assert.equal(names.length, revisions[i].length + 1);
      const sidecar = JSON.parse(readFileSync(join(result.orderDir, 'objednavka.json'), 'utf8'));
      assert.equal(sidecar.photos.length, revisions[i].length);
      assert.equal(sidecar.revision.fingerprint, sourceFingerprint({ ...ORDER, photos: revisions[i] }));
      if (i === 1) assert.equal(sidecar.revision.fingerprint, previousFingerprint, 'same source keeps the same identity');
      if (i > 1) assert.notEqual(sidecar.revision.fingerprint, previousFingerprint, 'meaningful source change gets a new identity');
      previousFingerprint = sidecar.revision.fingerprint;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
