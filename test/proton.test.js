import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeInbox, formatSender, toIso, addressOf } from '../src/proton/mailbox.js';
import { createBridgeClient, BridgeError } from '../src/proton/bridgeClient.js';
import { createSmtpClient, SmtpError } from '../src/proton/smtpClient.js';
import { MAIL_TEMPLATES, templateList, templateById, unfilledPlaceholders } from '../src/proton/templates.js';
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
      let uid = 100;
      for (const m of seed.messages ?? []) {
        yield {
          uid: m.uid ?? ++uid,
          envelope: { from: [{ name: m.name, address: m.address }], subject: m.subject, date: m.date },
          flags: new Set(m.seen ? ['\\Seen'] : []),
        };
      }
    }
    async fetchOne() {
      if (!seed.one) return null;
      return { uid: seed.one.uid, source: Buffer.from(seed.one.source ?? ''), flags: new Set(seed.one.seen ? ['\\Seen'] : []) };
    }
    async messageFlagsAdd(range, flags, opts) {
      (seed.flagsAdded ??= []).push({ range, flags, opts });
      return true;
    }
    async messageFlagsRemove(range, flags, opts) {
      (seed.flagsRemoved ??= []).push({ range, flags, opts });
      return true;
    }
    async messageMove(range, dest, opts) {
      if (seed.moveError) throw seed.moveError;
      (seed.moved ??= []).push({ range, dest, opts });
      return true;
    }
    async logout() {}
  }
  return async () => ({ ImapFlow: FakeImapFlow });
}

/** A fake mailparser: returns whatever the seed says the message parsed to. */
const fakeParseFactory = (parsed) => async () => ({ simpleParser: async () => parsed });

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

async function withServer({ mailClient, smtpClient, config = CONFIG }, run) {
  const root = mkdtempSync(join(tmpdir(), 'fma-mail-'));
  const inbox = join(root, 'inbox');
  const outbox = join(root, 'outbox');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(outbox, { recursive: true });
  const { server } = createReviewServer({ config, inboxRoot: inbox, outboxRoot: outbox, memoryRoot: outbox, driver: { generate: async () => {} }, mailClient, smtpClient });
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

// ---- addressOf + uid/fromAddress passthrough (reply prefill) ----------------

test('addressOf pulls the bare email from structured, array, and raw-string froms', () => {
  assert.equal(addressOf({ name: 'Jana', address: 'j@x.cz' }), 'j@x.cz');
  assert.equal(addressOf([{ address: 'a@x.cz' }, { address: 'b@x.cz' }]), 'a@x.cz');
  assert.equal(addressOf('Petr Malý <p@x.cz>'), 'p@x.cz');
  assert.equal(addressOf('lonely@x.cz'), 'lonely@x.cz');
  assert.equal(addressOf('no address here'), '');
  assert.equal(addressOf(null), '');
});

test('summarizeInbox carries the uid and reply address so a message can be opened and replied to', () => {
  const out = summarizeInbox({
    total: 1,
    unread: 0,
    messages: [{ uid: 77, from: { name: 'Jana', address: 'j@x.cz' }, subject: 'A', date: new Date('2026-07-10T08:00:00Z'), seen: true }],
  });
  assert.equal(out.recent[0].uid, 77);
  assert.equal(out.recent[0].fromAddress, 'j@x.cz');
});

// ---- bridgeClient.fetchMessage (fake imapflow + fake mailparser) ------------

test('fetchMessage opens one message by uid and returns its parsed body + threading headers', async () => {
  const parsed = {
    from: { value: [{ name: 'Babička', address: 'babicka@x.cz' }] },
    to: { text: 'info@fotomalovanky.cz' },
    subject: 'Dotaz k objednávce',
    date: new Date('2026-07-11T12:00:00Z'),
    text: 'Dobrý den, kdy dorazí?',
    html: '<p>Dobrý den, kdy dorazí?</p>',
    messageId: '<abc@x.cz>',
    references: ['<root@x.cz>'],
  };
  const client = createBridgeClient({
    user: 'u',
    pass: 'p',
    imapFactory: fakeImapFactory({ one: { uid: 77, source: 'raw', seen: false } }),
    parseFactory: fakeParseFactory(parsed),
  });
  const msg = await client.fetchMessage({ uid: 77 });
  assert.equal(msg.uid, 77);
  assert.equal(msg.from, 'Babička');
  assert.equal(msg.fromAddress, 'babicka@x.cz');
  assert.equal(msg.subject, 'Dotaz k objednávce');
  assert.equal(msg.text, 'Dobrý den, kdy dorazí?');
  assert.equal(msg.messageId, '<abc@x.cz>');
  assert.deepEqual(msg.references, ['<root@x.cz>']);
  assert.equal(msg.seen, false);
});

test('fetchMessage without a uid is a clear error, not a crash', async () => {
  const client = createBridgeClient({ user: 'u', pass: 'p', imapFactory: fakeImapFactory({}), parseFactory: fakeParseFactory({}) });
  await assert.rejects(() => client.fetchMessage({}), (e) => e instanceof BridgeError);
});

test('opening an UNREAD message marks it \\Seen so the unread badge clears', async () => {
  const seed = { one: { uid: 77, source: 'raw', seen: false } };
  const client = createBridgeClient({ user: 'u', pass: 'p', imapFactory: fakeImapFactory(seed), parseFactory: fakeParseFactory({ subject: 'x' }) });
  const msg = await client.fetchMessage({ uid: 77 });
  assert.equal(msg.seen, false, 'reports the state as opened (was unread)');
  assert.equal(seed.flagsAdded?.length, 1, 'the \\Seen flag was added exactly once');
  assert.deepEqual(seed.flagsAdded[0].flags, ['\\Seen']);
  assert.equal(seed.flagsAdded[0].opts?.uid, true, 'flagged by UID, not sequence number');
});

test('opening an already-read message does NOT re-flag it', async () => {
  const seed = { one: { uid: 5, source: 'raw', seen: true } };
  const client = createBridgeClient({ user: 'u', pass: 'p', imapFactory: fakeImapFactory(seed), parseFactory: fakeParseFactory({ subject: 'x' }) });
  const msg = await client.fetchMessage({ uid: 5 });
  assert.equal(msg.seen, true);
  assert.equal(seed.flagsAdded, undefined, 'no flag write for a message already \\Seen');
});

// ---- deleteMessage / setSeen (fake imapflow) -------------------------------

test('deleteMessage moves the message to Trash by UID', async () => {
  const seed = {};
  const client = createBridgeClient({ user: 'u', pass: 'p', imapFactory: fakeImapFactory(seed) });
  const out = await client.deleteMessage({ uid: 77 });
  assert.deepEqual(out, { uid: 77, deleted: true });
  assert.equal(seed.moved?.length, 1);
  assert.equal(seed.moved[0].range, '77');
  assert.equal(seed.moved[0].dest, 'Trash');
  assert.equal(seed.moved[0].opts?.uid, true, 'moved by UID, not sequence number');
});

test('deleteMessage without a uid is a clear BridgeError, not a crash', async () => {
  const client = createBridgeClient({ user: 'u', pass: 'p', imapFactory: fakeImapFactory({}) });
  await assert.rejects(() => client.deleteMessage({}), (e) => e instanceof BridgeError);
});

test('deleteMessage wraps an IMAP failure as a BridgeError', async () => {
  const client = createBridgeClient({ user: 'u', pass: 'p', imapFactory: fakeImapFactory({ moveError: new Error('no Trash') }) });
  await assert.rejects(() => client.deleteMessage({ uid: 3 }), (e) => e instanceof BridgeError);
});

test('setSeen adds \\Seen to mark read and removes it to mark unread', async () => {
  const seed = {};
  const client = createBridgeClient({ user: 'u', pass: 'p', imapFactory: fakeImapFactory(seed) });
  await client.setSeen({ uid: 9, seen: false });
  assert.equal(seed.flagsRemoved?.length, 1);
  assert.deepEqual(seed.flagsRemoved[0].flags, ['\\Seen']);
  assert.equal(seed.flagsRemoved[0].opts?.uid, true);
  await client.setSeen({ uid: 9, seen: true });
  assert.equal(seed.flagsAdded?.length, 1);
  assert.deepEqual(seed.flagsAdded[0].flags, ['\\Seen']);
});

// ---- templates (pure) ------------------------------------------------------

test('every template is signed David / Fotomalovánky.cz, never Lukáš', () => {
  assert.ok(MAIL_TEMPLATES.length >= 4);
  for (const t of MAIL_TEMPLATES) {
    assert.ok(t.id && t.label && t.body, `template ${t.id} is complete`);
    assert.match(t.body, /David/);
    assert.match(t.body, /Fotomalovánky\.cz/);
    assert.ok(!/Lukáš/.test(t.body), `template ${t.id} must not sign as Lukáš`);
  }
  assert.equal(templateById('storno')?.id, 'storno');
  assert.equal(templateById('nope'), null);
  assert.equal(templateList().length, MAIL_TEMPLATES.length);
});

test('unfilledPlaceholders flags bracketed all-caps tokens and ignores ordinary text', () => {
  assert.deepEqual(unfilledPlaceholders('Vaše Fotomalovánky #[ČÍSLO]', 'Odkaz: [ODKAZ]'), ['[ČÍSLO]', '[ODKAZ]']);
  assert.deepEqual(unfilledPlaceholders('Dobrý den, posíláme v příloze. David'), []);
  assert.deepEqual(unfilledPlaceholders('a [note] in lowercase'), [], 'lowercase brackets are not template placeholders');
});

// ---- smtpClient (fake transport, no network) -------------------------------

/** A nodemailer-like transport that records what it was asked to send. */
function fakeTransport(overrides = {}) {
  const sent = [];
  return {
    sent,
    factory: async () => ({
      async sendMail(message) {
        if (overrides.throw) throw overrides.throw;
        sent.push(message);
        return { messageId: '<generated@bridge>', accepted: [message.to] };
      },
    }),
  };
}

test('smtpClient sends from the Bridge account with the display name, and threads a reply', async () => {
  const t = fakeTransport();
  const smtp = createSmtpClient({ user: 'info@fotomalovanky.cz', pass: 'x', transportFactory: t.factory });
  const out = await smtp.sendMail({ to: 'babicka@x.cz', subject: 'Re: Dotaz', text: 'Dobrý den…', inReplyTo: '<abc@x.cz>', references: ['<root@x.cz>'] });
  assert.equal(out.messageId, '<generated@bridge>');
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].from, 'Fotomalovánky.cz <info@fotomalovanky.cz>', 'From is always the authenticated Bridge address');
  assert.equal(t.sent[0].to, 'babicka@x.cz');
  assert.equal(t.sent[0].inReplyTo, '<abc@x.cz>');
  assert.deepEqual(t.sent[0].references, ['<root@x.cz>']);
});

test('smtpClient refuses an empty recipient or body before opening a connection', async () => {
  const t = fakeTransport();
  const smtp = createSmtpClient({ user: 'u', pass: 'p', transportFactory: t.factory });
  await assert.rejects(() => smtp.sendMail({ to: '', text: 'x' }), (e) => e instanceof SmtpError && e.code === 'bad-input');
  await assert.rejects(() => smtp.sendMail({ to: 'a@x.cz', text: '  ' }), (e) => e instanceof SmtpError && e.code === 'bad-input');
  assert.equal(t.sent.length, 0, 'nothing is sent when the input is invalid');
});

test('smtpClient classifies an auth failure from the transport', async () => {
  const t = fakeTransport({ throw: Object.assign(new Error('Invalid login: authentication failed'), {}) });
  const smtp = createSmtpClient({ user: 'u', pass: 'p', transportFactory: t.factory });
  await assert.rejects(() => smtp.sendMail({ to: 'a@x.cz', text: 'x' }), (e) => e instanceof SmtpError && e.code === 'auth');
});

// ---- endpoints: /api/mail/message, /templates, /send -----------------------

test('GET /api/mail/message returns the opened message; /templates lists the approved set', async () => {
  const mailClient = { fetchMessage: async ({ uid }) => ({ uid, from: 'Babička', fromAddress: 'b@x.cz', subject: 'Dotaz', text: 'Dobrý den', messageId: '<m@x>', references: [] }) };
  await withServer({ mailClient }, async (origin) => {
    const msg = await (await fetch(`${origin}/api/mail/message?uid=77`)).json();
    assert.equal(msg.uid, 77);
    assert.equal(msg.text, 'Dobrý den');
    const tpls = await (await fetch(`${origin}/api/mail/templates`)).json();
    assert.ok(tpls.templates.length >= 4);
    assert.ok(tpls.templates.every((t) => /David/.test(t.body)));
  });
});

test('POST /api/mail/send sends via the injected SMTP client on an explicit call', async () => {
  const sent = [];
  const smtpClient = { sendMail: async (m) => { sent.push(m); return { messageId: '<ok@bridge>' }; } };
  await withServer({ smtpClient }, async (origin) => {
    const res = await fetch(`${origin}/api/mail/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'babicka@x.cz', subject: 'Re: Dotaz', body: 'Dobrý den, posíláme…\n\nDavid\nFotomalovánky.cz', inReplyTo: '<abc@x.cz>' }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).sent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'babicka@x.cz');
    assert.equal(sent[0].inReplyTo, '<abc@x.cz>');
  });
});

test('POST /api/mail/send refuses a body that still holds a [PLACEHOLDER] — nothing is sent', async () => {
  const sent = [];
  const smtpClient = { sendMail: async (m) => { sent.push(m); return {}; } };
  await withServer({ smtpClient }, async (origin) => {
    const res = await fetch(`${origin}/api/mail/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'a@x.cz', subject: 'Vaše Fotomalovánky #[ČÍSLO]', body: 'Odkaz: [ODKAZ]\nDavid' }) });
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.equal(j.code, 'placeholder');
    assert.deepEqual(j.placeholders.sort(), ['[ODKAZ]', '[ČÍSLO]']);
    assert.equal(sent.length, 0, 'a half-filled template never reaches SMTP');
  });
});

test('POST /api/mail/send with no SMTP configured is a clear 503, not a crash', async () => {
  await withServer({}, async (origin) => {
    const res = await fetch(`${origin}/api/mail/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'a@x.cz', body: 'x' }) });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'not-configured');
  });
});

// ---- endpoints: /api/mail/delete, /api/mail/flag ---------------------------

test('POST /api/mail/delete moves the message via the injected client', async () => {
  const deleted = [];
  const mailClient = { deleteMessage: async ({ uid }) => { deleted.push(uid); return { uid, deleted: true }; } };
  await withServer({ mailClient }, async (origin) => {
    const res = await fetch(`${origin}/api/mail/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: 77 }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { uid: 77, deleted: true });
    assert.deepEqual(deleted, [77]);
  });
});

test('POST /api/mail/delete rejects a bad uid and is a 503 when mail is off', async () => {
  const mailClient = { deleteMessage: async () => ({}) };
  await withServer({ mailClient }, async (origin) => {
    const bad = await fetch(`${origin}/api/mail/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: 'nope' }) });
    assert.equal(bad.status, 400);
  });
  await withServer({}, async (origin) => {
    const off = await fetch(`${origin}/api/mail/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: 5 }) });
    assert.equal(off.status, 503);
    assert.equal((await off.json()).code, 'not-configured');
  });
});

test('POST /api/mail/flag marks a message unread via the injected client', async () => {
  const flags = [];
  const mailClient = { setSeen: async ({ uid, seen }) => { flags.push({ uid, seen }); return { uid, seen }; } };
  await withServer({ mailClient }, async (origin) => {
    const res = await fetch(`${origin}/api/mail/flag`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: 9, seen: false }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { uid: 9, seen: false });
    assert.deepEqual(flags, [{ uid: 9, seen: false }]);
  });
});

test('POST /api/mail/flag turns a Bridge failure into a 502 with a code', async () => {
  const mailClient = { setSeen: async () => { throw new BridgeError('offline', 'Bridge not running'); } };
  await withServer({ mailClient }, async (origin) => {
    const res = await fetch(`${origin}/api/mail/flag`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: 9, seen: true }) });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, 'offline');
  });
});
