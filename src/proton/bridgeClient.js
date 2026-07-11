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
export function createBridgeClient({ host = '127.0.0.1', port = 1143, user, pass, secure = false, mailbox = 'INBOX', imapFactory } = {}) {
  const factory = imapFactory ?? (() => import('imapflow'));

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
          for await (const msg of client.fetch(`${first}:*`, { envelope: true, flags: true })) {
            messages.push({
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

  return { fetchInbox };
}
