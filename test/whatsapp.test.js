import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWhatsAppClient, WhatsAppError, chatIdOf, deliveryCaption } from '../src/whatsapp/whatsappClient.js';
import { createReviewServer } from '../src/ui/server.js';
import { deliveredMarkerPath } from '../src/studio.js';

// ---- chatIdOf / deliveryCaption (pure) -------------------------------------

test('chatIdOf normalizes numbers and passes through chat/group ids', () => {
  assert.equal(chatIdOf('420123456789'), '420123456789@c.us');
  assert.equal(chatIdOf('+420 123 456 789'), '420123456789@c.us');
  assert.equal(chatIdOf('420123456789@c.us'), '420123456789@c.us'); // already an id
  assert.equal(chatIdOf('120363000000000000@g.us'), '120363000000000000@g.us'); // group id
  assert.equal(chatIdOf(''), '');
  assert.equal(chatIdOf(null), '');
  assert.equal(chatIdOf('   '), '');
});

test('deliveryCaption is just the order number Jirka needs', () => {
  assert.equal(deliveryCaption('1510'), 'Objednávka 1510');
});

// ---- adapter with a fake whatsapp-web.js client ----------------------------

/** A stand-in for a whatsapp-web.js Client: an EventEmitter with initialize/sendMessage/destroy. */
class FakeWaClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.sent = [];
    this.initialized = false;
    this.destroyed = false;
  }
  async initialize() {
    this.initialized = true;
    if (this.opts.autoReady) this.emit('ready');
    if (this.opts.autoQr) this.emit('qr', 'QR-STRING');
  }
  async sendMessage(chatId, media, options) {
    if (this.opts.sendError) throw this.opts.sendError;
    this.sent.push({ chatId, media, options });
    return { id: { _serialized: 'msg-1' } };
  }
  async getChats() {
    return this.opts.chats ?? [];
  }
  async destroy() {
    this.destroyed = true;
  }
}

const fakeFactory = (fake) => async () => ({ client: fake, mediaFromFile: (p) => ({ path: p }) });
const fakeQr = async (text) => `data:image/png;base64,QR(${text})`;
const tick = () => new Promise((r) => setTimeout(r, 10));

test('status reports needs-qr with an encoded QR, then linked after ready', async () => {
  const fake = new FakeWaClient({ autoQr: true });
  const wa = createWhatsAppClient({ recipient: '420111', clientFactory: fakeFactory(fake), qrEncode: fakeQr });
  await wa.status();
  await tick(); // the QR encodes asynchronously — the next poll carries the image, like the dashboard
  const s = await wa.status();
  assert.equal(s.available, true);
  assert.equal(s.state, 'needs-qr');
  assert.equal(s.qr, 'data:image/png;base64,QR(QR-STRING)');
  assert.equal(s.recipient, '420111@c.us');

  fake.emit('ready');
  const s2 = await wa.status();
  assert.equal(s2.state, 'linked');
  assert.equal(s2.qr, null, 'the QR is dropped once linked');
});

test('sendDocument delivers the PDF to the chat id with the caption when linked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-wa-'));
  const pdf = join(dir, '1510 Final.pdf');
  writeFileSync(pdf, '%PDF-1.4\n');
  const fake = new FakeWaClient({ autoReady: true });
  const wa = createWhatsAppClient({ recipient: '420999', clientFactory: fakeFactory(fake), qrEncode: fakeQr });
  try {
    const out = await wa.sendDocument({ filePath: pdf, caption: deliveryCaption('1510') });
    assert.equal(out.sent, true);
    assert.equal(out.id, 'msg-1');
    assert.equal(out.to, '420999@c.us');
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0].chatId, '420999@c.us');
    assert.equal(fake.sent[0].media.path, pdf);
    assert.equal(fake.sent[0].options.caption, 'Objednávka 1510');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sendDocument refuses when the session is not linked (needs-qr) — nothing is sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-wa-'));
  const pdf = join(dir, 'x.pdf');
  writeFileSync(pdf, '%PDF');
  const fake = new FakeWaClient({ autoQr: true });
  const wa = createWhatsAppClient({ recipient: '420999', clientFactory: fakeFactory(fake), qrEncode: fakeQr });
  try {
    await wa.status(); // kick off init → needs-qr
    await assert.rejects(() => wa.sendDocument({ filePath: pdf, caption: 'x' }), (e) => e instanceof WhatsAppError && e.code === 'not-linked');
    assert.equal(fake.sent.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sendDocument rejects a missing file and a missing recipient before touching the client', async () => {
  const fake = new FakeWaClient({ autoReady: true });
  const noRecipient = createWhatsAppClient({ recipient: '', clientFactory: fakeFactory(fake), qrEncode: fakeQr });
  await assert.rejects(() => noRecipient.sendDocument({ filePath: 'whatever', caption: 'x' }), (e) => e instanceof WhatsAppError && e.code === 'bad-input');

  const wa = createWhatsAppClient({ recipient: '420999', clientFactory: fakeFactory(fake), qrEncode: fakeQr });
  await assert.rejects(() => wa.sendDocument({ filePath: join(tmpdir(), 'does-not-exist-xyz.pdf'), caption: 'x' }), (e) => e instanceof WhatsAppError && e.code === 'bad-input');
  assert.equal(fake.sent.length, 0);
});

test('a send failure from the client surfaces as WhatsAppError(send)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-wa-'));
  const pdf = join(dir, 'x.pdf');
  writeFileSync(pdf, '%PDF');
  const fake = new FakeWaClient({ autoReady: true, sendError: new Error('phone offline') });
  const wa = createWhatsAppClient({ recipient: '420999', clientFactory: fakeFactory(fake), qrEncode: fakeQr });
  try {
    await assert.rejects(() => wa.sendDocument({ filePath: pdf, caption: 'x' }), (e) => e instanceof WhatsAppError && e.code === 'send');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing whatsapp-web.js dependency reads as not-installed, not a crash', async () => {
  const wa = createWhatsAppClient({
    recipient: '420999',
    clientFactory: async () => {
      throw Object.assign(new Error("Cannot find package 'whatsapp-web.js'"), { code: 'ERR_MODULE_NOT_FOUND' });
    },
    qrEncode: fakeQr,
  });
  const s = await wa.status();
  assert.equal(s.state, 'not-installed');
  await assert.rejects(() => wa.sendDocument({ filePath: 'x', caption: 'y' }), (e) => e instanceof WhatsAppError && e.code === 'bad-input'); // missing file caught first
});

// ---- endpoints: /api/whatsapp, /api/<order>/deliver -----------------------

const CONFIG = { generator: { baseUrl: 'https://example.test/tok/', mode: 'api' }, builder: { baseUrl: 'https://example.test' }, paths: { inbox: './inbox', outbox: './outbox' } };

/** A server over a real inbox/outbox with one order '1510' whose book PDF exists (or not). */
async function withServer({ waClient, withPdf = true }, run) {
  const root = mkdtempSync(join(tmpdir(), 'fma-wadeliver-'));
  const inbox = join(root, 'inbox');
  const outbox = join(root, 'outbox');
  mkdirSync(join(inbox, '1510'), { recursive: true });
  const orderDir = join(outbox, '1510');
  mkdirSync(orderDir, { recursive: true });
  writeFileSync(join(inbox, '1510', 'a.jpeg'), 'jpeg');
  if (withPdf) writeFileSync(join(orderDir, '1510 Final.pdf'), '%PDF-1.4\n');
  const { server } = createReviewServer({ config: CONFIG, inboxRoot: inbox, outboxRoot: outbox, memoryRoot: outbox, driver: { generate: async () => {} }, waClient });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(origin, orderDir);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('GET /api/whatsapp reports disabled when no client is wired', async () => {
  await withServer({}, async (origin) => {
    const s = await (await fetch(`${origin}/api/whatsapp`)).json();
    assert.equal(s.available, false);
    assert.equal(s.state, 'disabled');
  });
});

test('GET /api/whatsapp returns the injected client status', async () => {
  const waClient = { status: async () => ({ available: true, state: 'linked', qr: null, recipient: '420@c.us' }) };
  await withServer({ waClient }, async (origin) => {
    const s = await (await fetch(`${origin}/api/whatsapp`)).json();
    assert.equal(s.state, 'linked');
  });
});

test('POST /api/<order>/deliver sends the PDF then marks the order delivered', async () => {
  const sent = [];
  const waClient = { sendDocument: async (m) => { sent.push(m); return { sent: true, id: 'msg-9', to: '420@c.us' }; } };
  await withServer({ waClient }, async (origin, orderDir) => {
    const res = await fetch(`${origin}/api/1510/deliver`, { method: 'POST' });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.status, 'sent');
    assert.equal(j.messageId, 'msg-9');
    assert.equal(sent.length, 1);
    assert.match(sent[0].filePath, /1510 Final\.pdf$/);
    assert.equal(sent[0].caption, 'Objednávka 1510');
    assert.ok(existsSync(deliveredMarkerPath(orderDir)), 'the delivery marker was written');
  });
});

test('a failed WhatsApp send does NOT mark the order delivered — it can be retried', async () => {
  const waClient = { sendDocument: async () => { throw new WhatsAppError('send', 'phone offline'); } };
  await withServer({ waClient }, async (origin, orderDir) => {
    const res = await fetch(`${origin}/api/1510/deliver`, { method: 'POST' });
    assert.equal(res.status, 502);
    const j = await res.json();
    assert.equal(j.code, 'send');
    assert.ok(!existsSync(deliveredMarkerPath(orderDir)), 'no marker — the order stays on the board');
  });
});

test('deliver is a 409 when the PDF is not built yet, and never sends', async () => {
  const sent = [];
  const waClient = { sendDocument: async (m) => { sent.push(m); return { sent: true }; } };
  await withServer({ waClient, withPdf: false }, async (origin) => {
    const res = await fetch(`${origin}/api/1510/deliver`, { method: 'POST' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'no-pdf');
    assert.equal(sent.length, 0);
  });
});

test('deliver with no WhatsApp configured is a clear 503, not a crash', async () => {
  await withServer({}, async (origin) => {
    const res = await fetch(`${origin}/api/1510/deliver`, { method: 'POST' });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'not-configured');
  });
});

test('listGroups returns only groups (id + name), once the session is linked', async () => {
  const fake = new FakeWaClient({
    autoReady: true,
    chats: [
      { isGroup: false, name: 'David', id: { _serialized: '420@c.us' } },
      { isGroup: true, name: 'Objednávky', id: { _serialized: '120363111@g.us' } },
      { isGroup: true, name: '', id: { _serialized: '' } }, // no id → dropped
    ],
  });
  const wa = createWhatsAppClient({ recipient: '420@c.us', clientFactory: fakeFactory(fake), qrEncode: fakeQr });
  await wa.status(); // kick off init → ready
  await tick();
  const groups = await wa.listGroups();
  assert.deepEqual(groups, [{ id: '120363111@g.us', name: 'Objednávky' }]);
});

test('shutdown() closes the WhatsApp client so the browser tears down cleanly on stop', async () => {
  let closed = 0;
  const waClient = { status: async () => ({ available: true, state: 'linked' }), close: async () => { closed++; } };
  const { server, shutdown } = createReviewServer({ config: CONFIG, driver: { generate: async () => {} }, waClient });
  server.close();
  await shutdown();
  assert.equal(closed, 1, 'the WhatsApp session was closed on shutdown');
});
