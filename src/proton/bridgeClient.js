// Adapter: read a Proton inbox over IMAP through Proton Mail Bridge, which exposes IMAP on
// 127.0.0.1 with Bridge-generated credentials and a self-signed cert. This is the ONLY seam that
// touches the network / imapflow; everything downstream works on the plain object it returns, so
// the dashboard logic stays testable with a fake (see mailbox.js + the /api/mail test).
//
// imapflow is imported lazily so the module still loads when the dependency or Bridge isn't there
// yet (the feature ships "offline" until David installs Bridge), and so tests can inject a fake.

export class BridgeError extends Error {
  /** code: 'offline' (Bridge not reachable) | 'auth' (bad Bridge credentials) | 'unknown'. */
  constructor(code, message, cause) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function classifyConnectError(err) {
  if (err?.authenticationFailed || err?.responseText?.match?.(/authenticat/i)) return 'auth';
  return 'offline'; // ECONNREFUSED / ETIMEDOUT / cert / Bridge-not-running all read as "offline"
}

function seenOf(flags) {
  if (!flags) return false;
  if (typeof flags.has === 'function') return flags.has('\\Seen');
  if (Array.isArray(flags)) return flags.includes('\\Seen');
  return false;
}

/** Build a reader bound to one Bridge account. `imapFactory` returns `{ ImapFlow }` — it defaults
 *  to the real dependency, imported on first use, and is overridden in tests with a fake. */
export function createBridgeClient({ host = '127.0.0.1', port = 1143, user, pass, secure = false, mailbox = 'INBOX', imapFactory, parseFactory } = {}) {
  const factory = imapFactory ?? (() => import('imapflow'));
  const parser = parseFactory ?? (() => import('mailparser')); // lazy: the reader path pulls in mailparser only when a message is opened

  /** Fetch mailbox totals + the most recent `limit` envelopes. Returns
   *  { total, unread, messages: [{ from, subject, date, seen }] }. Throws BridgeError on failure. */
  async function fetchInbox({ limit = 20 } = {}) {
    const { ImapFlow } = await factory();
    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass },
      logger: false,
      emitLogs: false,
      // Bridge presents a locally-generated self-signed cert on 127.0.0.1; there is no public CA to
      // validate it against, and the connection never leaves the loopback interface.
      tls: { rejectUnauthorized: false },
    });

    try {
      await client.connect();
    } catch (err) {
      throw new BridgeError(classifyConnectError(err), `Cannot reach Proton Bridge at ${host}:${port} — ${err.message}`, err);
    }

    try {
      const status = await client.status(mailbox, { messages: true, unseen: true });
      const total = Number.isInteger(status?.messages) ? status.messages : 0;
      const unread = Number.isInteger(status?.unseen) ? status.unseen : 0;

      const messages = [];
      if (total > 0) {
        const lock = await client.getMailboxLock(mailbox);
        try {
          const first = Math.max(1, total - limit + 1); // last `limit` by sequence number
          for await (const msg of client.fetch(`${first}:*`, { uid: true, envelope: true, flags: true })) {
            messages.push({
              uid: msg.uid ?? null, // the stable handle the reader opens a message by
              from: msg.envelope?.from ?? null,
              subject: msg.envelope?.subject ?? '',
              date: msg.envelope?.date ?? null,
              seen: seenOf(msg.flags),
            });
          }
        } finally {
          lock.release();
        }
      }
      return { total, unread, messages };
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError('unknown', `Reading the Proton inbox failed — ${err.message}`, err);
    } finally {
      try {
        await client.logout();
      } catch {
        /* best-effort; the read already succeeded or failed above */
      }
    }
  }

  /** Fetch one message's full body by UID, parsed into display + threading fields. Returns
   *  { uid, from, fromAddress, to, subject, date, seen, text, html, messageId, references } — the
   *  reader shows text/html; messageId/references let a reply thread correctly. Throws BridgeError. */
  async function fetchMessage({ box = mailbox, uid } = {}) {
    if (uid == null) throw new BridgeError('unknown', 'A message uid is required to open it.');
    const { ImapFlow } = await factory();
    const { simpleParser } = await parser();
    const client = new ImapFlow({ host, port, secure, auth: { user, pass }, logger: false, emitLogs: false, tls: { rejectUnauthorized: false } });

    try {
      await client.connect();
    } catch (err) {
      throw new BridgeError(classifyConnectError(err), `Cannot reach Proton Bridge at ${host}:${port} — ${err.message}`, err);
    }

    const lock = await client.getMailboxLock(box);
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
      if (!msg || !msg.source) throw new BridgeError('unknown', `Message ${uid} was not found in ${box}.`);
      const wasSeen = seenOf(msg.flags); // the state as opened — reported below, before we flip it
      const parsed = await simpleParser(msg.source);
      const fromAddr = parsed.from?.value?.[0] ?? null;

      // Opening a message marks it read on the server, so the unread badge clears and stays cleared
      // across polls (the tile's unread count is the IMAP unseen count, not a client-side guess).
      // Best-effort and only when it was actually unread: a flag-set hiccup must never stop the
      // operator from reading the message they just clicked.
      if (!wasSeen) {
        try {
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        } catch {
          /* keep the read; the next open or an explicit refresh will reconcile the flag */
        }
      }
      return {
        uid: Number(uid),
        from: fromAddr?.name || fromAddr?.address || '—',
        fromAddress: fromAddr?.address ?? '',
        to: parsed.to?.text ?? '',
        subject: parsed.subject ?? '',
        date: parsed.date ? parsed.date.toISOString() : null,
        seen: wasSeen,
        text: parsed.text ?? '',
        html: typeof parsed.html === 'string' ? parsed.html : '',
        messageId: parsed.messageId ?? '',
        references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [],
      };
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError('unknown', `Reading message ${uid} failed — ${err.message}`, err);
    } finally {
      try {
        lock.release();
        await client.logout();
      } catch {
        /* best-effort */
      }
    }
  }

  /** Open a locked connection to `box`, run `work(client)`, and always log out. Shared by the
   *  small write operations below (delete / flag), which each need one authenticated round-trip. */
  async function withMailbox(box, work) {
    const { ImapFlow } = await factory();
    const client = new ImapFlow({ host, port, secure, auth: { user, pass }, logger: false, emitLogs: false, tls: { rejectUnauthorized: false } });
    try {
      await client.connect();
    } catch (err) {
      throw new BridgeError(classifyConnectError(err), `Cannot reach Proton Bridge at ${host}:${port} — ${err.message}`, err);
    }
    const lock = await client.getMailboxLock(box);
    try {
      return await work(client);
    } finally {
      try {
        lock.release();
        await client.logout();
      } catch {
        /* best-effort */
      }
    }
  }

  /** Move one message to Trash (the reversible "delete" the operator expects — Proton keeps it in
   *  Trash, not gone forever). `trash` names the destination folder. Throws BridgeError on failure so
   *  the UI can say the delete didn't take rather than silently dropping it from the list. */
  async function deleteMessage({ box = mailbox, uid, trash = 'Trash' } = {}) {
    if (uid == null) throw new BridgeError('unknown', 'A message uid is required to delete it.');
    try {
      return await withMailbox(box, async (client) => {
        await client.messageMove(String(uid), trash, { uid: true });
        return { uid: Number(uid), deleted: true };
      });
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError('unknown', `Deleting message ${uid} failed — ${err.message}`, err);
    }
  }

  /** Mark one message read (`seen:true`) or unread (`seen:false`) by adding/removing the \Seen flag.
   *  Lets the operator flag a message to come back to. Throws BridgeError on failure. */
  async function setSeen({ box = mailbox, uid, seen } = {}) {
    if (uid == null) throw new BridgeError('unknown', 'A message uid is required to flag it.');
    try {
      return await withMailbox(box, async (client) => {
        if (seen) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        else await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
        return { uid: Number(uid), seen: Boolean(seen) };
      });
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError('unknown', `Flagging message ${uid} failed — ${err.message}`, err);
    }
  }

  return { fetchInbox, fetchMessage, deleteMessage, setSeen };
}
