// Adapter: deliver a finished book to Jirka's WhatsApp through whatsapp-web.js (a headless WhatsApp
// Web session kept alive with LocalAuth). This is the ONE outbound WhatsApp seam, and it fires only
// on the operator's explicit "Odeslat Jirkovi" click — never on its own, and never from the overnight
// autopilot (which builds the PDF but sends nothing to anyone). The no-send invariant lives here.
//
// whatsapp-web.js + qrcode are imported lazily so the module loads even before David installs them and
// does the one-time QR link; until then status() reports 'not-installed' with a clear instruction and
// sendDocument refuses. Tests inject a fake clientFactory and never touch the network or a browser.

import { existsSync } from 'node:fs';

export class WhatsAppError extends Error {
  /** code: 'disabled' | 'not-installed' | 'not-linked' | 'offline' | 'bad-input' | 'send'. */
  constructor(code, message, cause) {
    super(message);
    this.name = 'WhatsAppError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/** Normalize a recipient into a WhatsApp chat id. Accepts a bare number ("420123456789" or
 *  "+420 123 456 789"), or an already-formed id ("…@c.us" for a person, "…@g.us" for a group).
 *  '' when empty/unusable. */
export function chatIdOf(recipient) {
  const r = String(recipient ?? '').trim();
  if (!r) return '';
  if (/@(c|g)\.us$/i.test(r)) return r; // already a chat / group id
  const digits = r.replace(/[^0-9]/g, ''); // strip +, spaces, dashes
  return digits ? `${digits}@c.us` : '';
}

/** The caption Jirka sees under the PDF — the order number is all he needs to match the book. */
export function deliveryCaption(orderId) {
  return `Objednávka ${orderId}`;
}

function isModuleMissing(err) {
  const s = `${err?.code ?? ''} ${err?.message ?? ''}`;
  return /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/i.test(s);
}

/** Build a sender bound to one WhatsApp account + recipient. The whatsapp-web.js client is created
 *  and initialized lazily (on the first status()/send), so an enabled-but-not-yet-installed config
 *  never crashes the server. `clientFactory` returns `{ client, mediaFromFile }` and is overridden in
 *  tests with a fake; `qrEncode` turns a QR string into a data: URL the dashboard can render. */
export function createWhatsAppClient({ recipient, sessionDir, clientFactory, qrEncode, readyTimeoutMs = 60_000 } = {}) {
  let client = null; // the whatsapp-web.js Client (or the test fake)
  let mediaFromFile = null; // builds a MessageMedia from a file path
  let state = 'connecting'; // connecting | needs-qr | linked | offline | not-installed
  let qr = null; // latest QR as a data: URL, while state === 'needs-qr'
  let initError = null;
  let initStarted = false;
  const readyWaiters = [];

  const factory =
    clientFactory ??
    (async () => {
      const mod = await import('whatsapp-web.js');
      const { Client, LocalAuth, MessageMedia } = mod.default ?? mod;
      const auth = sessionDir ? new LocalAuth({ clientId: 'jirka', dataPath: sessionDir }) : new LocalAuth({ clientId: 'jirka' });
      const c = new Client({ authStrategy: auth, puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] } });
      return { client: c, mediaFromFile: (p) => MessageMedia.fromFilePath(p) };
    });
  const encodeQr =
    qrEncode ??
    (async (text) => {
      const mod = await import('qrcode');
      return (mod.default ?? mod).toDataURL(text);
    });

  function flushReady() {
    while (readyWaiters.length) readyWaiters.shift()();
  }

  function wireEvents() {
    client.on('qr', async (data) => {
      state = 'needs-qr';
      try {
        qr = await encodeQr(data);
      } catch {
        qr = null; // couldn't encode; the dashboard still shows "scan needed", just without the image
      }
    });
    client.on('authenticated', () => {
      qr = null;
    });
    client.on('ready', () => {
      state = 'linked';
      qr = null;
      flushReady();
    });
    client.on('auth_failure', () => {
      state = 'needs-qr';
    });
    client.on('disconnected', () => {
      state = 'offline';
    });
  }

  async function ensureStarted() {
    if (initStarted) return;
    initStarted = true;
    let made;
    try {
      made = await factory();
    } catch (err) {
      // The dependency isn't installed yet (the common case before David's morning setup), or the
      // client couldn't be built. Either way the tile shows a clear next step rather than crashing.
      state = isModuleMissing(err) ? 'not-installed' : 'offline';
      initError = err;
      return;
    }
    client = made.client;
    mediaFromFile = made.mediaFromFile;
    wireEvents();
    // Do NOT await: whatsapp-web.js's initialize() resolves only once the session is ready, which for
    // a fresh link never happens until the QR is scanned. Events drive `state`; sends wait on 'ready'.
    Promise.resolve(client.initialize()).catch((err) => {
      state = 'offline';
      initError = err;
    });
  }

  /** Wait until the session is linked, or fail fast with the reason it can't send right now. */
  function waitForReady() {
    if (state === 'linked') return Promise.resolve();
    if (state === 'not-installed') return Promise.reject(new WhatsAppError('not-installed', 'WhatsApp (whatsapp-web.js) is not installed yet — run: npm install whatsapp-web.js qrcode'));
    if (state === 'needs-qr') return Promise.reject(new WhatsAppError('not-linked', 'WhatsApp is not linked yet — otevřete Objednávky a naskenujte QR kód.'));
    if (state === 'offline') return Promise.reject(new WhatsAppError('offline', `WhatsApp session is not connected${initError ? ` — ${initError.message}` : ''}.`));
    // state === 'connecting': give the session a moment to come up before giving up.
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const code = state === 'needs-qr' ? 'not-linked' : 'offline';
        reject(new WhatsAppError(code, code === 'not-linked' ? 'WhatsApp is not linked yet — naskenujte QR kód.' : 'WhatsApp se nepodařilo připojit včas.'));
      }, readyTimeoutMs);
      readyWaiters.push(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** The link state the dashboard renders: whether a QR needs scanning, and the QR image if so.
   *  Always resolves (never throws) so the status tile is stable. */
  async function status() {
    await ensureStarted();
    return { available: true, state, qr: state === 'needs-qr' ? qr : null, recipient: chatIdOf(recipient) || null };
  }

  /** Send one PDF to Jirka with the order-number caption. Throws WhatsAppError on any failure so the
   *  caller can keep the order OFF 'sent' and let the operator retry — a book is only marked delivered
   *  when this resolves. `to` overrides the configured recipient (defaults to Jirka). */
  async function sendDocument({ filePath, caption = '', to } = {}) {
    const dest = chatIdOf(to ?? recipient);
    if (!dest) throw new WhatsAppError('bad-input', 'Není nastaven příjemce (Jirkovo WhatsApp číslo).');
    if (!filePath || !existsSync(filePath)) throw new WhatsAppError('bad-input', `Soubor k odeslání nenalezen: ${filePath}`);
    await ensureStarted();
    await waitForReady();
    let media;
    try {
      media = await mediaFromFile(filePath);
    } catch (err) {
      throw new WhatsAppError('send', `PDF se nepodařilo načíst k odeslání — ${err.message}`, err);
    }
    try {
      const msg = await client.sendMessage(dest, media, { caption: String(caption) });
      return { sent: true, id: msg?.id?._serialized ?? msg?.id ?? null, to: dest };
    } catch (err) {
      throw new WhatsAppError('send', `Odeslání na WhatsApp selhalo — ${err.message}`, err);
    }
  }

  async function close() {
    try {
      await client?.destroy?.();
    } catch {
      /* best-effort shutdown */
    }
  }

  return { status, sendDocument, close };
}
