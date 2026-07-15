import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selectAutoRunOrders } from '../src/autoRun.js';

// Build one order folder in `inbox`. `photos` names are the extension's "<id>_img<NNNN>_-_x" form so
// the ingested orderId comes from the photos. `settledSecAgo` back-dates every file's mtime so the
// settle check sees a finished download; omit it to leave files fresh (still-being-written).
function makeOrder(inbox, folder, { info, photos, settledSecAgo } = {}) {
  const dir = join(inbox, folder);
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const name of photos) {
    const p = join(dir, name);
    writeFileSync(p, 'x');
    files.push(p);
  }
  if (info !== undefined) {
    const p = join(dir, 'objednavka.json');
    writeFileSync(p, JSON.stringify(info));
    files.push(p);
  }
  if (settledSecAgo) {
    const t = Date.now() / 1000 - settledSecAgo;
    for (const p of files) utimesSync(p, t, t);
  }
}

test('selectAutoRunOrders: fires only for complete, settled, unprocessed orders', () => {
  const root = mkdtempSync(join(tmpdir(), 'autorun-'));
  const inbox = join(root, 'in');
  const outbox = join(root, 'out');
  mkdirSync(inbox); mkdirSync(outbox);

  // 1523 — complete (2/2 photos + dedication) and settled → READY
  makeOrder(inbox, '1523', { info: { expectedPhotos: 2, dedication: 'Pro Jiříčka' }, photos: ['1523_img0001_-_a.jpg', '1523_img0002_-_b.jpg'], settledSecAgo: 60 });
  // 1524 — no objednavka.json (dedication not landed) → NOT ready
  makeOrder(inbox, '1524', { photos: ['1524_img0001_-_a.jpg'], settledSecAgo: 60 });
  // 1525 — download incomplete (1 of 3 photos) → NOT ready
  makeOrder(inbox, '1525', { info: { expectedPhotos: 3 }, photos: ['1525_img0001_-_a.jpg'], settledSecAgo: 60 });
  // 1526 — complete but just written (not settled) → NOT ready
  makeOrder(inbox, '1526', { info: { expectedPhotos: 1 }, photos: ['1526_img0001_-_a.jpg'] });
  // 1527 — complete + settled, but already processed (outbox state.json exists) → NOT ready
  makeOrder(inbox, '1527', { info: { expectedPhotos: 1 }, photos: ['1527_img0001_-_a.jpg'], settledSecAgo: 60 });
  mkdirSync(join(outbox, '1527'), { recursive: true });
  writeFileSync(join(outbox, '1527', 'state.json'), '{}');

  const ready = selectAutoRunOrders({ inbox, outbox });
  assert.deepEqual(ready, ['1523'], 'only the complete+settled+unprocessed order fires');

  rmSync(root, { recursive: true, force: true });
});

test('selectAutoRunOrders: no expectedPhotos in objednavka.json still fires when settled', () => {
  const root = mkdtempSync(join(tmpdir(), 'autorun-'));
  const inbox = join(root, 'in');
  const outbox = join(root, 'out');
  mkdirSync(inbox); mkdirSync(outbox);

  // Older extension: objednavka.json present but no expectedPhotos → count check is advisory, settle governs.
  makeOrder(inbox, '1600', { info: { dedication: 'x' }, photos: ['1600_img0001_-_a.jpg'], settledSecAgo: 60 });
  assert.deepEqual(selectAutoRunOrders({ inbox, outbox }), ['1600']);

  rmSync(root, { recursive: true, force: true });
});
