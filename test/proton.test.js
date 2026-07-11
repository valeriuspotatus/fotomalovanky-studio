import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeInbox, formatSender, toIso } from '../src/proton/mailbox.js';
import { createBridgeClient, BridgeError } from '../src/proton/bridgeClient.js';
import { createReviewServer } from '../src/ui/server.js';

// ---- summarizeInbox / formatSender (pure) ----------------------------------

test('formatSender prefers the display name, falls back to the address, then a dash', () => {
  assert.equal(formatSender({ name: 'Jana Nováková', address: 'j@x.cz' }), 'Jana Nováková');
  assert.equal(formatSender({ name: '', address: 'k@x.cz' }), 'k@x.cz');
  assert.equal(formatSender([{ name: 'První', address: 'a@x.cz' }, { name: 'Druhá' }]), 'První'); // first of many
  assert.equal(formatSender('Petr Malý <p@x.cz>'), 'Petr Malý'); // raw header string
  assert.equal(formatSender('lonely@x.cz'), 'lonely@x.cz');
  assert.equal(formatSender(null), '—');
});

test('toIso accepts Date / ISO / epoch and rejects junk', () => {
  assert.equal(toIso(new Date('2026-07-10T09:00:00Z')), '2026-07-10T09:00:00.000Z');
  assert.equal(toIso('2026-07-10T09:00:00Z'), '2026-07-10T09:00:00.000Z');
  assert.equal(toIso('not a date'), null);
  assert.equal(toIso(undefined), null);
});

test('summarizeInbox sorts newest-first, caps to the limit, and carries the mailbox counts', () => {
  const raw = {
    total: 42,
    unread: 3,
    messages: [
      { from: { name: 'Older', address: 'o@x.cz' }, subject: 'A', date: new Date('2026-07-01T08:00:00Z'), seen: true },
      { from: { name: 'Newest', address: 'n@x.cz' }, subject: 'B', date: new Date('2026-07-10T08:00:00Z'), seen: false },
      { from: { name: 'Middle', address: 'm@x.cz' }, subject: '', date: new Date('2026-07-05T08:00:00Z'), seen: true },
    ],
  };
  const out = summarizeInbox(raw, { limit: 2 });
  assert.equal(out.available, true);
  assert.equal(out.total, 42);
  assert.equal(out.unread, 3);
  assert.equal(out.recent.length, 2); // capped
  assert.deepEqual(out.recent.map((m) => m.from), ['Newest', 'Middle']); // newest-first
  assert.equal(out.recent[1].subject, '(bez předmětu)'); // empty subject filled
});

test('summarizeInbox clamps bad counts and tolerates an empty / missing inbox', () => {
  const out = summarizeInbox({ total: -5, unread: 'nope', messages: null });
  assert.deepEqual(out, { available: true, unread: 0, total: 0, recent: [] });
});

// ---- bridgeClient adapter (fake imapflow, no network) ----------------------

/** A stand-in for imapflow: connect/status/lock/fetch/logout over seeded data. */
function fakeImapFactory(seed) {
  class FakeImapFlow {
    constructor(opts) {
      this.opts = opts;
    }
    async connect() {
      if (seed.connectError) throw seed.connectError;
    }
    async status() {
      return { messages: seed.total, unseen: seed.unseen };
    }
    async getMailboxLock() {
      return { release() {} };
    }
    async *fetch() {
      for (const m of seed.messages ?? []) {
        yield {
          envelope: { from: [{ name: m.name, address: m.address }], subject: m.subject, date: m.date },
          flags: new Set(m.seen ? ['\\Seen'] : []),
        };
      }
    }
    async logout() {}
  }
  return async () => ({ ImapFlow: FakeImapFlow });
}

test('bridgeClient reads counts from STATUS and normalizes envelopes + the \\Seen flag', async () => {
  const client = createBridgeClient({
    user: 'u',
    pass: 'p',
    imapFactory: fakeImapFactory({
      total: 2,
      unseen: 1,
      messages: [
        { name: 'Jana', address: 'j@x.cz', subject: 'Ahoj', date: new Date('2026-07-10T09:00:00Z'), seen: false },
        { name: '', address: 'k@x.cz', subject: 'Re', date: new Date('2026-07-09T09:00:00Z'), seen: true },
      ],
    }),
  });
  const raw = await client.fetchInbox({ limit: 10 });
  assert.equal(raw.total, 2);
  assert.equal(raw.unread, 1);
  assert.equal(raw.messages.length, 2);
  assert.equal(raw.messages[0].seen, false);
  assert.equal(raw.messages[1].seen, true);
  // and the pure layer turns that into the tile shape
  assert.equal(summarizeInbox(raw).recent[0].from, 'Jana');
});

test('bridgeClient maps a refused connection to offline and bad credentials to auth', async () => {
  const offline = createBridgeClient({ user: 'u', pass: 'p', imapFactory: fakeImapFactory({ connectError: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }) });
  await assert.rejects(() => offline.fetchInbox(), (e) => e instanceof BridgeError && e.code === 'offline');

  const auth = createBridgeClient({ user: 'u', pass: 'p', imapFactory: fakeImapFactory({ connectError: Object.assign(new Error('no'), { authenticationFailed: true }) }) });
  await assert.rejects(() => auth.fetchInbox(), (e) => e instanceof BridgeError && e.code === 'auth');
});

// ---- GET /api/mail (endpoint wiring) ---------------------------------------

const CONFIG = { generator: { baseUrl: 'https://example.test/tok/', mode: 'api' }, builder: { baseUrl: 'https://example.test' }, paths: { inbox: './inbox', outbox: './outbox' } };

async function withServer({ mailClient, config = CONFIG }, run) {
  const root = mkdtempSync(join(tmpdir(), 'fma-mail-'));
  const inbox = join(root, 'inbox');
  const outbox = join(root, 'outbox');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(outbox, { recursive: true });
  const { server } = createReviewServer({ config, inboxRoot: inbox, outboxRoot: outbox, memoryRoot: outbox, driver: { generate: async () => {} }, mailClient });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(origin);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('GET /api/mail with no mail configured reports not-configured, not an error', async () => {
  await withServer({}, async (origin) => {
    const res = await fetch(`${origin}/api/mail`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { available: false, reason: 'not-configured' });
  });
});

test('GET /api/mail returns the inbox summary from the injected client', async () => {
  const mailClient = {
    fetchInbox: async () => ({ total: 5, unread: 2, messages: [{ from: { name: 'Babička', address: 'b@x.cz' }, subject: 'Fotky', date: new Date('2026-07-10T10:00:00Z'), seen: false }] }),
  };
  await withServer({ mailClient }, async (origin) => {
    const m = await (await fetch(`${origin}/api/mail`)).json();
    assert.equal(m.available, true);
    assert.equal(m.total, 5);
    assert.equal(m.unread, 2);
    assert.equal(m.recent[0].from, 'Babička');
    assert.ok(m.fetchedAt, 'the payload is timestamped');
  });
});

test('GET /api/mail turns a Bridge failure into an offline state, still HTTP 200', async () => {
  const mailClient = {
    fetchInbox: async () => {
      throw new BridgeError('offline', 'Bridge not running');
    },
  };
  await withServer({ mailClient }, async (origin) => {
    const res = await fetch(`${origin}/api/mail`);
    assert.equal(res.status, 200);
    const m = await res.json();
    assert.equal(m.available, false);
    assert.equal(m.reason, 'offline');
  });
});
