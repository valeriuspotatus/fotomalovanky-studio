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
