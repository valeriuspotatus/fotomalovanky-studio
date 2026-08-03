import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { materializeOrder } from '../src/shopify/materialize.js';
import { isPhoto } from '../src/organize.js';

// The upload host serves some photos as PNG/WebP, but organize.js only ingests .jpg/.jpeg — so an
// order like #1525 downloaded as PNG would land in the folder yet be silently skipped by the
// pipeline. materializeOrder must re-encode non-JPEG photos so every one reaches ingest.

const ORDER = { orderId: '9001', dedication: 'Pro Aničku', email: 'x@y.cz', layout: null, products: [], photos: [] };
const swatch = (bg) => sharp({ create: { width: 4, height: 4, channels: 3, background: bg } });

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
