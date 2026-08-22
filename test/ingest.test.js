import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { ingestOrders, orderIdFromPhoto, IngestError } from '../src/ingest.js';

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fma-ingest-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const touch = (...parts) => writeFileSync(join(...parts), 'x');

test('orderIdFromPhoto reads the extension naming, and gives up cleanly on anything else', () => {
  assert.equal(orderIdFromPhoto('1523_img0002_-_hofbauerovi_18.7.2026.jpeg'), '1523');
  assert.equal(orderIdFromPhoto(join('a', 'b', '1510_img0001_-_to_jsem_ja_barca.jpg')), '1510');
  assert.equal(orderIdFromPhoto('holiday-snap.jpg'), null);
});

test('each photo-bearing subfolder becomes one order, non-image files ignored', () => {
  fixture((root) => {
    mkdirSync(join(root, '1510'));
    mkdirSync(join(root, '1523'));
    touch(root, '1510', '1510_img0001_-_barca.jpeg');
    touch(root, '1510', 'notes.txt');
    touch(root, '1510', 'state.json');
    touch(root, '1523', '1523_img0001_-_hofbauerovi.jpeg');
    touch(root, '1523', '1523_img0002_-_hofbauerovi.jpeg');

    const orders = ingestOrders(root);
    assert.deepEqual(
      orders.map((o) => [o.orderId, o.photos.length]),
      [['1510', 1], ['1523', 2]],
    );
    assert.deepEqual(orders[1].photos.map((p) => basename(p)), [
      '1523_img0001_-_hofbauerovi.jpeg',
      '1523_img0002_-_hofbauerovi.jpeg',
    ]);
  });
});

test('a subfolder with no photos is not an order', () => {
  fixture((root) => {
    mkdirSync(join(root, 'archive'));
    touch(root, 'archive', 'readme.txt');
    assert.deepEqual(ingestOrders(root), []);
  });
});

test('HEIC and HEIF files remain visible to intake instead of silently disappearing', () => {
  fixture((root) => {
    const dir = join(root, '1900');
    mkdirSync(dir);
    writeFileSync(join(dir, '1900_img0001_-_iphone.HEIC'), 'synthetic');
    writeFileSync(join(dir, '1900_img0002_-_iphone.heif'), 'synthetic');
    const [order] = ingestOrders(root);
    assert.equal(order.photos.length, 2);
  });
});

test('hidden materialization staging directories are never ingested', () => {
  fixture((root) => {
    const dir = join(root, '.fotomalovanky-staging', '1900-crash');
    mkdirSync(dir, { recursive: true });
    touch(dir, '1900_img0001_-_partial.jpeg');
    assert.deepEqual(ingestOrders(root), []);
  });
});

test('generated outputs in an order folder are never mistaken for input photos', () => {
  fixture((root) => {
    mkdirSync(join(root, '1510'));
    touch(root, '1510', '1510_img0001_-_barca.jpeg');
    touch(root, '1510', '1510_img0001_-_barca_bw.png');
    touch(root, '1510', '1510_img0001_-_barca.svg');

    const [order] = ingestOrders(root);
    assert.deepEqual(order.photos.map((p) => basename(p)), ['1510_img0001_-_barca.jpeg']);
  });
});

test('the photo names decide the order id, not a hand-edited folder name', () => {
  // The operator's real sample: a folder called "…Objednávka 1522…" holding 1523_img* photos.
  fixture((root) => {
    mkdirSync(join(root, 'Objednávka 1522'));
    touch(root, 'Objednávka 1522', '1523_img0001_-_hofbauerovi_18.7.2026.jpeg');
    touch(root, 'Objednávka 1522', '1523_img0002_-_hofbauerovi_18.7.2026.jpeg');

    const [order] = ingestOrders(root);
    assert.equal(order.orderId, '1523');
    assert.equal(order.dirName, 'Objednávka 1522', 'the folder name is kept so a mismatch can be reported');
  });
});

test('photos that disagree on an order id fall back to the folder name', () => {
  fixture((root) => {
    mkdirSync(join(root, 'mixed'));
    touch(root, 'mixed', '1510_img0001_-_a.jpeg');
    touch(root, 'mixed', '1523_img0001_-_b.jpeg');
    assert.equal(ingestOrders(root)[0].orderId, 'mixed');
  });
});

test('one un-prefixed photo is enough to fall back to the folder name', () => {
  fixture((root) => {
    mkdirSync(join(root, 'partial'));
    touch(root, 'partial', '1510_img0001_-_a.jpeg'); // agrees...
    touch(root, 'partial', 'holiday-snap.jpeg'); // ...but this one carries no order number
    assert.equal(ingestOrders(root)[0].orderId, 'partial');
  });
});

test('pointing straight at one order folder works, id taken from the photo names', () => {
  fixture((root) => {
    touch(root, '1510_img0001_-_barca.jpeg');
    touch(root, '1510_img0002_-_barca.jpeg');
    const orders = ingestOrders(root);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].orderId, '1510');
    assert.equal(orders[0].photos.length, 2);
  });
});

test('a loose folder of unnamed photos falls back to the folder name as the order id', () => {
  fixture((root) => {
    touch(root, 'holiday-snap.jpg');
    const [order] = ingestOrders(root);
    assert.equal(order.orderId, basename(root));
  });
});

test('orders sort numerically, not lexically', () => {
  fixture((root) => {
    for (const id of ['9', '10', '1510']) {
      mkdirSync(join(root, id));
      touch(root, id, `${id}_img0001_-_x.jpeg`);
    }
    assert.deepEqual(ingestOrders(root).map((o) => o.orderId), ['9', '10', '1510']);
  });
});

test('an empty input folder yields no orders rather than an error', () => {
  fixture((root) => assert.deepEqual(ingestOrders(root), []));
});

test('a missing input folder raises an actionable IngestError, not a stack trace', () => {
  const missing = join(tmpdir(), 'fma-does-not-exist-9f3c');
  assert.throws(() => ingestOrders(missing), (err) => {
    assert.ok(err instanceof IngestError);
    assert.equal(err.seam, 'ingest');
    assert.match(err.message, /Input folder not found/);
    assert.match(err.message, /Chrome extension/);
    return true;
  });
});

// --- a book from a multi-book purchase ----------------------------------------------------------

test('orderIdFromPhoto reads a position suffix, and still reads a bare order number', () => {
  assert.equal(orderIdFromPhoto('1234-1_img0001_-_foto.jpg'), '1234-1', 'the suffix is part of the id, not stripped');
  assert.equal(orderIdFromPhoto('1234-12_img0003_-_foto.jpeg'), '1234-12', 'a two-digit position still reads');
  // The Chrome-extension shape is untouched: it has no line-item concept and never suffixes.
  assert.equal(orderIdFromPhoto('1523_img0002_-_hofbauerovi_18.7.2026.jpeg'), '1523');
  assert.equal(orderIdFromPhoto('holiday-snap.jpg'), null);
});

test('a book folder resolves through its filenames, not the folder-name fallback', () => {
  fixture((root) => {
    const dir = join(root, '1234-2');
    mkdirSync(dir);
    touch(dir, '1234-2_img0001_-_a.jpg');
    touch(dir, '1234-2_img0002_-_b.jpg');
    const [order] = ingestOrders(root);
    assert.equal(order.orderId, '1234-2');
    // Prove the filename path did the work: every photo yields the id on its own.
    assert.deepEqual(order.photos.map((p) => orderIdFromPhoto(p)), ['1234-2', '1234-2']);
  });
});

test('photos that disagree still fall back to the folder name, suffix or not', () => {
  fixture((root) => {
    const dir = join(root, '1234-2');
    mkdirSync(dir);
    touch(dir, '1234-2_img0001_-_a.jpg');
    touch(dir, '1299-1_img0002_-_b.jpg');
    const [order] = ingestOrders(root);
    assert.equal(order.orderId, '1234-2', 'no consensus, so the folder name decides — as it always has');
  });
});

test('a suffixed folder holding bare-numbered photos resolves to the bare number (known hazard, pinned)', () => {
  fixture((root) => {
    const dir = join(root, '1234-1');
    mkdirSync(dir);
    touch(dir, '1234_img0001_-_a.jpg');
    touch(dir, '1234_img0002_-_b.jpg');
    const [order] = ingestOrders(root);
    // This is the re-merge door: photos unanimously claim "1234", so filename consensus wins and
    // the position is lost. materializeOrder never writes this shape (it names photos with the full
    // job id), but a hand-assembled or manually-pulled folder can. Asserted so the behaviour is
    // visible rather than latent — if it ever needs to change, this test says so out loud.
    assert.equal(order.orderId, '1234', 'filenames still beat the folder name; only materialize keeps them in step');
  });
});
