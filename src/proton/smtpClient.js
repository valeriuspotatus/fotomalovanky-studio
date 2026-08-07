// Adapter: send mail through Proton Mail Bridge's local SMTP (127.0.0.1:1025 by default), with the
// same username + Bridge password as IMAP and the same self-signed cert on loopback. This is the ONE
// outbound seam — the dashboard composer calls it only on an explicit "Odeslat" click; nothing here
// sends on its own. nodemailer is imported lazily so the module loads even where the dep/Bridge isn't
// present yet, and so tests can inject a fake transport.

import { tlsFor } from './bridgeClient.js';

export class SmtpError extends Error {
  /** code: 'bad-input' | 'auth' | 'offline' | 'send'. */
  constructor(code, message, cause) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/** Build a sender bound to one Bridge account. `transportFactory` returns a nodemailer-like transport
 *  ({ sendMail }); it defaults to the real dependency and is overridden in tests. `fromName` is the
 *  display name on the From header. Auth is always the Bridge `user`, but the visible From can be any
 *  address that account owns — an alias / send-as (`fromAddress`) — which Proton accepts; it rejects
 *  only addresses the account does not own. Defaults to the account address. */
export function createSmtpClient({ host = '127.0.0.1', port = 1025, user, pass, secure = false, fromName = 'Fotomalovánky.cz', fromAddress, transportFactory } = {}) {
  const sender = (fromAddress && String(fromAddress).trim()) || user;
  const makeTransport =
    transportFactory ??
    (async () => {
      const nm = await import('nodemailer');
      const createTransport = nm.createTransport ?? nm.default?.createTransport;
      // Certificate verification is off ONLY on loopback, where Bridge presents its own self-signed
      // cert and the traffic never leaves the machine — see tlsFor(). Sending through a real mail
      // host without verification would offer the mailbox password to anyone in the middle.
      return createTransport({ host, port, secure, auth: { user, pass }, tls: tlsFor(host) });
    });

  /** Send one message. `to` and `text` are required; `inReplyTo`/`references` thread a reply; the From
   *  header uses `sender` (the configured alias, or the Bridge account when none is set). */
  async function sendMail({ to, subject = '', text, inReplyTo = '', references = [], attachments = [] } = {}) {
    if (!to || !String(to).trim()) throw new SmtpError('bad-input', 'A recipient (to) is required.');
    if (!text || !String(text).trim()) throw new SmtpError('bad-input', 'The message body is empty.');

    const message = { from: fromName ? `${fromName} <${sender}>` : sender, to: String(to).trim(), subject: String(subject), text: String(text) };
    if (inReplyTo) message.inReplyTo = inReplyTo;
    if (references && references.length) message.references = references;
    if (attachments && attachments.length) message.attachments = attachments;

    let transport;
    try {
      transport = await makeTransport();
    } catch (err) {
      throw new SmtpError('offline', `Could not open an SMTP connection to Bridge at ${host}:${port} — ${err.message}`, err);
    }
    try {
      const info = await transport.sendMail(message);
      return { messageId: info?.messageId ?? null, accepted: info?.accepted ?? [] };
    } catch (err) {
      const code = /auth/i.test(err?.message || '') ? 'auth' : /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ESOCKET/i.test(err?.code || err?.message || '') ? 'offline' : 'send';
      throw new SmtpError(code, `Could not send the email — ${err.message}`, err);
    }
  }

  return { sendMail };
}
