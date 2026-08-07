import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backfillAttribution, purchaseNumber } from '../src/backfillAttribution.js';

// The migration that fills the homepage's Zdroj column in for orders downloaded before the shop's
// channel was recorded. It rewrites files that also hold the dedication the customer typed and the
// address needed to reach them, so most of what matters here is what it does NOT touch.

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-backfill-'));
  const inbox = join(root, 'inbox');
  const outbox = join(root, 'outbox');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(outbox, { recursive: true });
  return { root, config: { paths: { inbox, outbox } }, inbox, outbox, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

/** An order folder with a sidecar, as materialize.js writes one. */
const order = (root, name, sidecar) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'objednavka.json'), JSON.stringify(sidecar, null, 2));
  return dir;
};

const read = (dir) => JSON.parse(readFileSync(join(dir, 'objednavka.json'), 'utf8'));

/** A client that answers from a map and records what it was asked for. */
const clientFor = (byName) => {
  const asked = [];
  return {
    asked,
    fetchOrderByName: async (name) => {
      asked.push(name);
      return byName[name] ?? null;
    },
  };
};

const node = (source, utm = null) => ({ customerJourneySummary: { firstVisit: { source, utmParameters: utm } } });
const PAID = { source: 'facebook', medium: 'paid', campaign: 'A+ sales - 3-2026' };

test('a dry run reports what it would do and changes nothing on disk', async () => {
  const f = fixture();
  try {
    const dir = order(f.inbox, '1601', { order: '1601', dedication: 'Pro Adélku', customer: { email: 'a@b.cz' } });
    const before = readFileSync(join(dir, 'objednavka.json'), 'utf8');

    const counts = await backfillAttribution({ config: f.config, client: clientFor({ 1601: node('facebook', PAID) }) });
    assert.equal(counts.patched, 1, 'it says it would patch one');
    assert.equal(readFileSync(join(dir, 'objednavka.json'), 'utf8'), before, 'and the file is byte-identical');
  } finally {
    f.cleanup();
  }
});

test('a write patches attribution and leaves every other field byte-identical', async () => {
  const f = fixture();
  try {
    const dir = order(f.inbox, '1602', {
      order: '1602',
      dedication: 'Pro Jiříčka',
      customer: { surname: '', email: 'hofbauerova@example.cz' },
      photos: ['https://cdn.tigren.com/a.jpg'],
    });

    await backfillAttribution({ config: f.config, client: clientFor({ 1602: node('facebook', PAID) }), write: true });
    const after = read(dir);

    assert.deepEqual(after.attribution, { source: 'facebook', medium: 'paid', campaign: 'A+ sales - 3-2026', channel: 'paid' });
    assert.equal(after.dedication, 'Pro Jiříčka', 'the accented dedication survives untouched');
    assert.equal(after.customer.email, 'hofbauerova@example.cz', 'and so does the address needed to reach them');
    assert.deepEqual(after.photos, ['https://cdn.tigren.com/a.jpg']);
  } finally {
    f.cleanup();
  }
});

test('running it twice patches nothing the second time', async () => {
  const f = fixture();
  try {
    order(f.inbox, '1603', { order: '1603' });
    const client = clientFor({ 1603: node('Google') });
    const first = await backfillAttribution({ config: f.config, client, write: true });
    const second = await backfillAttribution({ config: f.config, client, write: true });

    assert.equal(first.patched, 1);
    assert.equal(second.patched, 0);
    assert.equal(second.already, 1, 'the second run recognises its own work');
  } finally {
    f.cleanup();
  }
});

test('an order name that contains a hyphen is looked up whole, not split', async () => {
  // "1524-9" as a NAME is a real shape here — test/shopifyOrders.test.js pins it — and splitting it
  // would ask Shopify for order 1524 and write a different customer's channel onto this folder.
  const f = fixture();
  try {
    const dir = order(f.inbox, '1524-9', { order: '1524-9', purchase: { orderId: '1524-9', position: 1, of: 1 } });
    const client = clientFor({ '1524-9': node('Google'), 1524: node('facebook', PAID) });

    await backfillAttribution({ config: f.config, client, write: true });

    assert.deepEqual(client.asked, ['1524-9'], 'it asked for the whole name');
    assert.equal(read(dir).attribution.channel, 'organic', 'and wrote the right order’s channel');
  } finally {
    f.cleanup();
  }
});

test('the books of one purchase share a single lookup', async () => {
  const f = fixture();
  try {
    for (const n of ['1563-1', '1563-2', '1563-3']) {
      order(f.inbox, n, { order: n, purchase: { orderId: '1563', position: 1, of: 3 } });
    }
    const client = clientFor({ 1563: node('facebook', PAID) });
    const counts = await backfillAttribution({ config: f.config, client, write: true });

    assert.equal(counts.patched, 3);
    assert.deepEqual(client.asked, ['1563'], 'one query for the purchase, not one per book');
  } finally {
    f.cleanup();
  }
});

test('an order Shopify cannot find is skipped, never guessed at', async () => {
  const f = fixture();
  try {
    const dir = order(f.inbox, '1604', { order: '1604', dedication: 'Pro Terezku' });
    const counts = await backfillAttribution({ config: f.config, client: clientFor({}), write: true });

    assert.equal(counts.unresolved, 1);
    assert.equal(counts.patched, 0);
    assert.equal(read(dir).attribution, undefined, 'nothing invented');
    assert.equal(read(dir).dedication, 'Pro Terezku');
  } finally {
    f.cleanup();
  }
});

test('a failed lookup is counted apart from a genuine not-found', async () => {
  // A rate-limited run reported as "not found" reads as a shop missing half its orders, and sends
  // the operator looking for the wrong problem.
  const f = fixture();
  try {
    order(f.inbox, '1605', { order: '1605' });
    const counts = await backfillAttribution({
      config: f.config,
      client: { fetchOrderByName: async () => { throw new Error('Admin API throttled'); } },
      write: true,
    });
    assert.equal(counts.failed, 1);
    assert.equal(counts.unresolved, 0);
  } finally {
    f.cleanup();
  }
});

test('a sidecar that is unreadable, or not an object, is skipped rather than crashing the run', async () => {
  const f = fixture();
  try {
    const broken = join(f.inbox, '1606');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'objednavka.json'), '{"order":');
    const nulled = join(f.inbox, '1607');
    mkdirSync(nulled, { recursive: true });
    writeFileSync(join(nulled, 'objednavka.json'), 'null');
    order(f.inbox, '1608', { order: '1608' }); // a good one after the bad ones

    const counts = await backfillAttribution({ config: f.config, client: clientFor({ 1608: node('direct') }), write: true });

    assert.equal(counts.unreadable, 2);
    assert.equal(counts.patched, 1, 'the run carries on to the healthy folder');
    assert.equal(readFileSync(join(broken, 'objednavka.json'), 'utf8'), '{"order":', 'the broken file is left exactly as it was');
  } finally {
    f.cleanup();
  }
});

test('purchaseNumber prefers what the sidecar already knows over splitting a folder name', () => {
  assert.equal(purchaseNumber({ purchase: { orderId: '1563' } }, '1563-5'), '1563');
  assert.equal(purchaseNumber({ order: '1524-9' }, '1524-9'), '1524-9', 'a hyphenated NAME survives');
  assert.equal(purchaseNumber({}, '1563-5'), '1563', 'and the split is the last resort');
  assert.equal(purchaseNumber(null, '1601'), '1601');
});
