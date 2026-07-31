import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, utimesSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { backfillSentMarkers, planSentMarkerBackfill, SentMarkerMigrationError, SKIP_REASONS } from '../src/migrations/sentMarker.js';
import { createReviewServer } from '../src/ui/server.js';
import { hashPassword, ROLE_ENV_VARS } from '../src/auth/credentials.js';
import { SIGN_IN_PATH } from '../src/auth/sessions.js';

// The migration writes into live customer order folders, so almost everything here is an assertion
// about what it does NOT do. The one thing it does do — write a dispatch marker for an order already
// printed — is asserted on the marker's MTIME, because that is the only clock retention.js reads.

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0); // whole seconds: the mtimes below carry no sub-ms part

/** A throwaway outbox. `printedDaysAgo` back-dates the printed marker's mtime, which is the fact the
 *  migration has to carry across — a marker written today would restart retention at day zero. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fma-migrate-'));
  const outbox = join(root, 'outbox');
  mkdirSync(outbox, { recursive: true });

  const order = (id, { printed = null, printedDaysAgo = 100, delivered = false, sent = null, sentDaysAgo = 5 } = {}) => {
    const dir = join(outbox, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id} Final.pdf`), '%PDF-1.4\n');
    if (printed !== null) {
      const path = join(dir, 'printed.json');
      writeFileSync(path, printed);
      const when = new Date(NOW - printedDaysAgo * DAY_MS);
      utimesSync(path, when, when);
    }
    // The RETIRED marker, under its old meaning: handed to Jirka, not yet printed.
    if (delivered) writeFileSync(join(dir, 'delivered.json'), JSON.stringify({ at: '2026-02-02T00:00:00.000Z', by: 'operator' }));
    if (sent !== null) {
      const path = join(dir, 'sent.json');
      writeFileSync(path, sent);
      const when = new Date(NOW - sentDaysAgo * DAY_MS);
      utimesSync(path, when, when);
    }
    return dir;
  };

  return { root, outbox, order, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Every file under a folder with its bytes and mtime — the "nothing was touched" oracle. */
function snapshot(dir, base = dir, out = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) snapshot(path, base, out);
    else out[relative(base, path)] = { bytes: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs };
  }
  return out;
}

const marker = (dir, name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const mtime = (dir, name) => statSync(join(dir, name)).mtimeMs;

// ---- the write path ---------------------------------------------------------

test('AE9 — a printed order gains a backfilled dispatch marker carrying the PRINTED marker\'s mtime (R17)', () => {
  const f = fixture();
  try {
    const dir = f.order('1400', { printed: JSON.stringify({ at: '2026-04-22T09:00:00.000Z', by: 'Jirka' }), printedDaysAgo: 100 });
    const printedMtime = mtime(dir, 'printed.json');

    const result = backfillSentMarkers({ outboxRoot: f.outbox, apply: true });

    assert.deepEqual(result.written, ['1400'], 'the one printed order is the one written');
    assert.equal(existsSync(join(dir, 'sent.json')), true, 'it now carries a dispatch marker');

    // THE ASSERTION THIS UNIT EXISTS FOR. retention.js measures age from the marker file's mtime and
    // never from `at`, so a marker written now would silently hand this order another 100 days of
    // retention. Asserting the JSON field instead would pass while the purge gate had regressed.
    assert.equal(mtime(dir, 'sent.json'), printedMtime, 'the backfilled marker inherits the printed marker\'s clock');
    assert.notEqual(mtime(dir, 'sent.json'), Date.now(), 'and is emphatically not dated from the migration run');
    assert.ok(Date.now() - mtime(dir, 'sent.json') > 90 * DAY_MS, 'a book printed 100 days ago stays 100 days old');

    const written = marker(dir, 'sent.json');
    assert.equal(written.backfilled, true, 'flagged, so the board can refuse to treat it as a real dispatch');
    assert.equal(written.at, '2026-04-22T09:00:00.000Z', 'dated from the printed marker it was derived from');
    assert.equal(written.by, 'Jirka', 'and it names who the printed marker named');
    assert.equal(written.backfilledFrom, 'printed.json', 'the report of where it came from travels with it');
  } finally {
    f.cleanup();
  }
});

test('a printed marker with no `at` still backfills, dated from the file\'s own mtime', () => {
  const f = fixture();
  try {
    const dir = f.order('1401', { printed: '{}', printedDaysAgo: 40 });
    backfillSentMarkers({ outboxRoot: f.outbox, apply: true });
    assert.equal(mtime(dir, 'sent.json'), mtime(dir, 'printed.json'), 'the clock is the mtime either way');
    assert.equal(marker(dir, 'sent.json').at, new Date(mtime(dir, 'printed.json')).toISOString(), '`at` falls back to that same mtime');
  } finally {
    f.cleanup();
  }
});

// ---- the orders it must leave completely alone ------------------------------

test('an order carrying ONLY the retired delivery marker gains nothing (R16, KTD6)', () => {
  const f = fixture();
  try {
    // The dangerous row of the migration table: handed to Jirka under the old model, never printed
    // and never posted to anyone. A dispatch marker here would post it to a customer on paper only,
    // and start a retention clock on a live order's photographs.
    const dir = f.order('1402', { delivered: true });
    const before = snapshot(f.outbox);

    const result = backfillSentMarkers({ outboxRoot: f.outbox, apply: true });

    assert.equal(existsSync(join(dir, 'sent.json')), false, 'no dispatch marker is written for a delivery marker');
    assert.deepEqual(result.written, [], 'and nothing is reported as written');
    assert.equal(result.skipped.find((s) => s.orderId === '1402').reason, SKIP_REASONS.NOT_PRINTED, 'it is reported as still awaiting print');
    assert.deepEqual(snapshot(f.outbox), before, 'the delivery marker itself is not read, moved, rewritten or deleted');
  } finally {
    f.cleanup();
  }
});

test('an order with neither marker gains nothing', () => {
  const f = fixture();
  try {
    const dir = f.order('1403');
    const before = snapshot(f.outbox);
    const result = backfillSentMarkers({ outboxRoot: f.outbox, apply: true });
    assert.equal(existsSync(join(dir, 'sent.json')), false);
    assert.deepEqual(result.written, []);
    assert.deepEqual(snapshot(f.outbox), before, 'an untouched order stays untouched');
  } finally {
    f.cleanup();
  }
});

test('an order already carrying a dispatch marker is untouched, INCLUDING its mtime', () => {
  const f = fixture();
  try {
    const dir = f.order('1404', {
      printed: JSON.stringify({ at: '2026-01-01T00:00:00.000Z' }),
      printedDaysAgo: 200,
      sent: JSON.stringify({ at: '2026-07-01T00:00:00.000Z', by: 'David' }),
      sentDaysAgo: 5,
    });
    const before = snapshot(f.outbox);

    const result = backfillSentMarkers({ outboxRoot: f.outbox, apply: true });

    assert.deepEqual(result.written, [], 'a real dispatch is never overwritten by a derived one');
    assert.deepEqual(snapshot(f.outbox), before, 'bytes and mtime both survive — re-dating it would move the purge date');
    assert.equal(result.skipped.find((s) => s.orderId === '1404').reason, SKIP_REASONS.ALREADY_SENT);
  } finally {
    f.cleanup();
  }
});

test('a malformed printed marker is reported and skipped, never guessed at', () => {
  const f = fixture();
  try {
    const broken = f.order('1405', { printed: '{ this is not json' });
    const notObject = f.order('1406', { printed: '"a string"' });
    const before = snapshot(f.outbox);

    const result = backfillSentMarkers({ outboxRoot: f.outbox, apply: true });

    assert.deepEqual(result.written, [], 'no marker is derived from one that could not be read');
    assert.equal(existsSync(join(broken, 'sent.json')), false);
    assert.equal(existsSync(join(notObject, 'sent.json')), false);
    for (const id of ['1405', '1406']) {
      assert.equal(result.skipped.find((s) => s.orderId === id).reason, SKIP_REASONS.UNREADABLE, `${id} is reported, not silently passed over`);
    }
    assert.deepEqual(snapshot(f.outbox), before);
  } finally {
    f.cleanup();
  }
});

// ---- report-before-write, and idempotence -----------------------------------

test('the report names what would be written, and writing nothing is the default', () => {
  const f = fixture();
  try {
    f.order('1407', { printed: JSON.stringify({ at: '2026-03-03T00:00:00.000Z' }), printedDaysAgo: 60 });
    f.order('1408', { delivered: true });
    const before = snapshot(f.outbox);

    const report = backfillSentMarkers({ outboxRoot: f.outbox });

    assert.equal(report.applied, false, 'reporting is the default posture, like the purge');
    assert.deepEqual(report.written, [], 'a report writes nothing');
    assert.deepEqual(report.planned.map((p) => p.orderId), ['1407'], 'and names the order it intends to write');
    assert.equal(report.planned[0].at, '2026-03-03T00:00:00.000Z', 'with the date it would carry');
    assert.equal(report.planned[0].mtimeMs, mtime(join(f.outbox, '1407'), 'printed.json'), 'and the clock it would inherit');
    assert.deepEqual(snapshot(f.outbox), before, 'the tree is byte- and mtime-identical after the report');

    // The same plan is what the write path executes, so the operator confirms what he read.
    assert.deepEqual(planSentMarkerBackfill({ outboxRoot: f.outbox }).planned.map((p) => p.orderId), ['1407']);
    const applied = backfillSentMarkers({ outboxRoot: f.outbox, apply: true });
    assert.deepEqual(applied.written, ['1407'], 'confirmation writes exactly what the report named');
  } finally {
    f.cleanup();
  }
});

test('a second run changes nothing — the whole fixture is idempotent', () => {
  const f = fixture();
  try {
    f.order('1409', { printed: JSON.stringify({ at: '2026-02-01T00:00:00.000Z' }), printedDaysAgo: 150 });
    f.order('1410', { delivered: true });
    f.order('1411');
    f.order('1412', { printed: '{}', printedDaysAgo: 20, sent: JSON.stringify({ at: '2026-07-20T00:00:00.000Z' }) });
    f.order('1413', { printed: 'nonsense{' });

    const first = backfillSentMarkers({ outboxRoot: f.outbox, apply: true });
    assert.deepEqual(first.written, ['1409'], 'only the printed-and-undispatched order is written');
    const afterFirst = snapshot(f.outbox);

    const second = backfillSentMarkers({ outboxRoot: f.outbox, apply: true });
    assert.deepEqual(second.written, [], 'the second run has nothing left to do');
    assert.deepEqual(snapshot(f.outbox), afterFirst, 'and provably touched nothing, mtimes included');
    assert.equal(second.skipped.find((s) => s.orderId === '1409').reason, SKIP_REASONS.ALREADY_SENT, 'its own marker now protects it');
  } finally {
    f.cleanup();
  }
});

test('a missing outbox is refused at the migration seam rather than silently doing nothing', () => {
  const f = fixture();
  try {
    assert.throws(
      () => backfillSentMarkers({ outboxRoot: join(f.root, 'no-such-outbox') }),
      (err) => err instanceof SentMarkerMigrationError && err.seam === 'migration',
      'a folder it cannot read is a stop condition, not an empty result',
    );
  } finally {
    f.cleanup();
  }
});

// ---- the operator-only trigger ---------------------------------------------

const PASSWORD = 'correct horse battery staple';
const CONFIG = {
  generator: { baseUrl: 'https://fotomalovanky-app.onrender.com/tok3n/', mode: 'api', variant: '2509_1.5' },
  builder: { baseUrl: 'https://example.test/builder' },
  paths: { inbox: './inbox', outbox: './outbox' },
};

/** A gated studio over a migration fixture, with a signed-in cookie for each person. */
async function routeFixture() {
  const f = fixture();
  const inbox = join(f.root, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const hash = await hashPassword(PASSWORD, { logN: 14, r: 8, p: 1 });
  const { server } = createReviewServer({
    config: { ...CONFIG, accounts: { dataDir: join(f.root, 'accounts') } },
    inboxRoot: inbox,
    outboxRoot: f.outbox,
    memoryRoot: f.root,
    driver: { generate: async () => {} },
    authEnv: { [ROLE_ENV_VARS.operator]: hash, [ROLE_ENV_VARS.printer]: hash },
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const signIn = async (username) => {
    const res = await fetch(`${origin}${SIGN_IN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    assert.equal(res.status, 200, `${username} signs in`);
    return String(res.headers.get('set-cookie')).split(';')[0];
  };
  return {
    ...f,
    operator: await signIn('David'),
    printer: await signIn('Jirka'),
    migrate: (cookie, body) =>
      fetch(`${origin}/api/migrate/sent-markers`, {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
    cleanup: () => { server.close(); f.cleanup(); },
  };
}

test('the migration route reports by default and writes NOTHING until it is confirmed', async () => {
  const f = await routeFixture();
  try {
    f.order('1500', { printed: JSON.stringify({ at: '2026-03-01T00:00:00.000Z' }), printedDaysAgo: 120 });
    f.order('1501', { delivered: true });
    const before = snapshot(f.outbox);

    const report = await (await f.migrate(f.operator)).json();
    assert.equal(report.applied, false, 'an unconfirmed call is a report');
    assert.deepEqual(report.written, []);
    assert.deepEqual(report.planned.map((p) => p.orderId), ['1500'], 'it says what it would write, before writing it');
    assert.deepEqual(snapshot(f.outbox), before, 'the outbox tree is unchanged — byte for byte, mtime for mtime');

    const applied = await (await f.migrate(f.operator, { confirm: true })).json();
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.written, ['1500'], 'the separate confirmation is what writes');
    assert.equal(existsSync(join(f.outbox, '1500', 'sent.json')), true);
    assert.equal(existsSync(join(f.outbox, '1501', 'sent.json')), false, 'and the delivery-only order is still left alone');
    assert.equal(mtime(join(f.outbox, '1500'), 'sent.json'), mtime(join(f.outbox, '1500'), 'printed.json'), 'through the route, the clock is preserved too');
  } finally {
    f.cleanup();
  }
});

test('the migration route is refused for a printer identity, and refuses it before writing anything', async () => {
  const f = await routeFixture();
  try {
    f.order('1502', { printed: JSON.stringify({ at: '2026-03-01T00:00:00.000Z' }), printedDaysAgo: 120 });
    const before = snapshot(f.outbox);

    for (const body of [{}, { confirm: true }]) {
      const res = await f.migrate(f.printer, body);
      assert.equal(res.status, 403, 'a migration over customer folders belongs to the operator');
      assert.equal((await res.json()).code, 'forbidden', 'and refuses with the role code');
    }
    assert.deepEqual(snapshot(f.outbox), before, 'the refusal is a refusal, not a silent no-op');
  } finally {
    f.cleanup();
  }
});
