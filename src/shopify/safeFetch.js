// Allowlisted, SSRF-hardened fetch for order-supplied photo URLs.
//
// The photo URL comes from order/line-item data — potentially app- or customer-influenced — so an
// unconstrained server-side fetch of it is an SSRF hole (against localhost — the local dashboard
// server — or internal hosts) and a token-exfil hole. This fetcher refuses anything that is not:
//   - https,
//   - on the explicit host allowlist (exact host, or a subdomain of an allowlisted host),
//   - resolving to a public (non-private, non-loopback, non-link-local) IP,
//   - an image, within a size cap.
//
// The confirmed photo host (U0/KTD6) is cdn.tigren.com — a PUBLIC CDN, not a Shopify host — so no
// credential is ever sent here: safeFetch attaches no auth at all. That is deliberate: the token
// must never leak to a non-Shopify host.

import dns from 'node:dns/promises';

export class PhotoFetchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PhotoFetchError';
  }
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // photos are ~0.5MB; 25MB is a generous ceiling.

/** host is allowed when it equals an allowlist entry or is a subdomain of one. Exact-suffix match:
 *  "cdn.tigren.com" allows "cdn.tigren.com" and "x.cdn.tigren.com", not "evilcdn.tigren.com.bad". */
function hostAllowed(host, allowlist) {
  const h = host.toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    return h === e || h.endsWith('.' + e);
  });
}

/** IPv4/IPv6 that must never be reached from a server-side fetch. */
function isPrivateAddress(addr) {
  if (addr.includes(':')) {
    const a = addr.toLowerCase();
    return a === '::1' || a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd') || a === '::';
  }
  const p = addr.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Fetch a photo URL under the guards above. Returns { buffer, contentType, ext }.
 *  Throws PhotoFetchError on any guard failure — the caller marks the order incomplete. */
export async function safeFetch(url, { allowlist = [], maxBytes = DEFAULT_MAX_BYTES, fetchImpl = fetch, lookup = dns.lookup } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new PhotoFetchError(`not a valid URL: ${String(url).slice(0, 80)}`);
  }
  if (parsed.protocol !== 'https:') throw new PhotoFetchError(`refused non-https URL (${parsed.protocol})`);
  if (!allowlist.length || !hostAllowed(parsed.hostname, allowlist)) {
    throw new PhotoFetchError(`host ${parsed.hostname} is not on the photo allowlist`);
  }

  // Resolve and reject private/loopback targets (SSRF via a public name pointing inward).
  let addrs;
  try {
    addrs = await lookup(parsed.hostname, { all: true });
  } catch (err) {
    throw new PhotoFetchError(`could not resolve ${parsed.hostname}: ${err.message}`);
  }
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) throw new PhotoFetchError(`${parsed.hostname} resolves to a private address (${address})`);
  }

  const res = await fetchImpl(url, { redirect: 'error' }); // no auth header — see file header
  if (!res.ok) throw new PhotoFetchError(`photo fetch returned HTTP ${res.status}`);

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) throw new PhotoFetchError(`refused non-image content-type "${contentType || 'unknown'}"`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new PhotoFetchError(`photo exceeds ${maxBytes} bytes (${buffer.length})`);
  if (buffer.length === 0) throw new PhotoFetchError('photo body was empty');

  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  return { buffer, contentType, ext };
}
