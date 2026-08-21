// Outbound email adapter for Proton Mail Bridge (or another configured SMTP host). Nothing here sends
// on its own: the dashboard calls it only after an explicit operator action. Nodemailer stays lazy so
// tests can inject a transport and installations without Bridge can still load the module.
import { tlsFor } from './bridgeClient.js';
import { setTimeout as sleep } from 'node:timers/promises';

export class SmtpError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export function createSmtpClient({
  host = '127.0.0.1', port = 1025, user, pass, secure = false,
  fromName = 'Fotomalovánky.cz', fromAddress, transportFactory,
  maxRetries = 2, backoffBaseMs = 500,
  delay = sleep, random = Math.random,
} = {}) {
  const sender = (fromAddress && String(fromAddress).trim()) || user;
  const makeTransport = transportFactory ?? (async () => {
    const nm = await import('nodemailer');
    const createTransport = nm.createTransport ?? nm.default?.createTransport;
    // tlsFor permits Bridge's self-signed certificate only on loopback; remote SMTP stays verified.
    return createTransport({ host, port, secure, auth: { user, pass }, tls: tlsFor(host) });
  });

  async function sendMail({ to, subject = '', text, inReplyTo = '', references = [], attachments = [] } = {}) {
    if (!to || !String(to).trim()) throw new SmtpError('bad-input', 'A recipient (to) is required.');
    if (!text || !String(text).trim()) throw new SmtpError('bad-input', 'The message body is empty.');

    const message = { from: fromName ? `${fromName} <${sender}>` : sender, to: String(to).trim(), subject: String(subject), text: String(text) };
    if (inReplyTo) message.inReplyTo = inReplyTo;
    if (references?.length) message.references = references;
    if (attachments?.length) message.attachments = attachments;

    for (let attempt = 0; ; attempt++) {
      try {
        const transport = await makeTransport();
        const info = await transport.sendMail(message);
        return { messageId: info?.messageId ?? null, accepted: info?.accepted ?? [] };
      } catch (err) {
        const auth = err?.responseCode === 535 || /auth|invalid login/i.test(err?.message || '');
        const network = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|ESOCKET/i.test(`${err?.code || ''} ${err?.message || ''}`);
        // A network error after SMTP submission begins is ambiguous: the server may have accepted
        // the message before the acknowledgement was lost. Retrying that can email the customer
        // twice. Only an explicit temporary SMTP rejection proves the message was not accepted.
        const transient = err?.responseCode >= 400 && err?.responseCode < 500;
        const code = auth ? 'auth' : network ? 'offline' : 'send';
        if (!auth && transient && attempt < maxRetries) {
          await delay(backoffBaseMs * 2 ** attempt * (1 + random()));
          continue;
        }
        const attempts = attempt + 1;
        const context = attempt ? ` after ${attempts} attempts` : '';
        const action = code === 'offline' ? `open an SMTP connection to ${host}:${port}` : 'send the email';
        const failure = new SmtpError(code, `Could not ${action}${context} - ${err.message}`, err);
        failure.attempts = attempts;
        throw failure;
      }
    }
  }

  return { sendMail };
}
