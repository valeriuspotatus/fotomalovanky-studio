// Pure inbox-summary logic for the dashboard's "Pošta" tile. No network, no IMAP — it takes the
// envelopes the Bridge adapter already fetched and shapes them for the client. Kept pure so the
// sender parsing, sorting, and truncation are testable without a live mailbox (the adapter that
// actually speaks IMAP to Proton Bridge lives in bridgeClient.js).

/** Pull a human display name out of an envelope "from". IMAP gives structured address objects
 *  ({ name, address }); we also accept a raw "Name <addr@host>" string as a fallback. Returns the
 *  name when present, else the address, else a dash. */
export function formatSender(from) {
  if (!from) return '—';
  // imapflow envelope address: { name, address } or an array of them (take the first).
  const one = Array.isArray(from) ? from[0] : from;
  if (one && typeof one === 'object') {
    const name = typeof one.name === 'string' ? one.name.trim() : '';
    const address = typeof one.address === 'string' ? one.address.trim() : '';
    return name || address || '—';
  }
  if (typeof one === 'string') {
    const m = one.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/); // "Jana Nováková <jana@x.cz>"
    if (m) return (m[1].trim() || m[2].trim());
    return one.trim() || '—';
  }
  return '—';
}

/** The bare email address of an envelope "from", for prefilling a reply's recipient. Accepts the
 *  structured { address } (or an array of them) and a raw "Name <addr@host>" string. '' when none. */
export function addressOf(from) {
  if (!from) return '';
  const one = Array.isArray(from) ? from[0] : from;
  if (one && typeof one === 'object' && typeof one.address === 'string') return one.address.trim();
  if (typeof one === 'string') {
    const m = one.match(/<([^>]+)>/);
    if (m) return m[1].trim();
    return one.includes('@') ? one.trim() : '';
  }
  return '';
}

/** Coerce a message date (Date, ISO string, or epoch ms) to an ISO string, or null if unusable.
 *  The client formats it for display; we only guarantee it sorts and parses. */
export function toIso(date) {
  if (date instanceof Date) return Number.isNaN(date.getTime()) ? null : date.toISOString();
  if (typeof date === 'number' && Number.isFinite(date)) return new Date(date).toISOString();
  if (typeof date === 'string') {
    const t = Date.parse(date);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

/** Shape a raw fetch into the payload the "Pošta" tile renders. `raw` is what the Bridge adapter
 *  returns: { total, unread, messages: [{ from, subject, date, seen }] } — total/unread come from
 *  the IMAP mailbox status (authoritative), `messages` is the recent slice to preview. We normalise
 *  senders, drop unparseable dates to the end, sort newest-first, and cap to `limit`. */
export function summarizeInbox(raw, { limit = 6 } = {}) {
  const total = Number.isInteger(raw?.total) && raw.total >= 0 ? raw.total : 0;
  const unread = Number.isInteger(raw?.unread) && raw.unread >= 0 ? raw.unread : 0;
  const messages = Array.isArray(raw?.messages) ? raw.messages : [];

  const recent = messages
    .map((m) => ({
      uid: Number.isInteger(m?.uid) ? m.uid : null, // the handle the reader opens the message by
      from: formatSender(m?.from),
      fromAddress: addressOf(m?.from),
      subject: typeof m?.subject === 'string' && m.subject.trim() ? m.subject.trim() : '(bez předmětu)',
      date: toIso(m?.date),
      seen: m?.seen === true,
    }))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')) // ISO strings sort chronologically
    .slice(0, Math.max(0, limit));

  return { available: true, unread, total, recent };
}
