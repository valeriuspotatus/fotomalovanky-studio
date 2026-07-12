import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeFetch, PhotoFetchError } from '../src/shopify/safeFetch.js';

// safeFetch is the autopilot's SSRF / token-exfil boundary (U3 acceptance criterion): the photo URL is
// order-supplied data, so an unconstrained server-side fetch of it could hit localhost/internal hosts
// or leak a credential. Everything here drives it with an injected fetch + DNS so no packet ever leaves.

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const ALLOW = ['cdn.tigren.com'];

/** A fetch stub that records the options it was called with and returns a canned image response. */
function fakeFetch({ status = 200, contentType = 'image/jpeg', body = JPEG } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  fn.calls = calls;
  return fn;
}

const publicLookup = async () => [{ address: '93.184.216.34' }];

test('a non-https URL is refused before any fetch', async () => {
  const fetchImpl = fakeFetch();
  await assert.rejects(() => safeFetch('http://cdn.tigren.com/a.jpg', { allowlist: ALLOW, fetchImpl, lookup: publicLookup }), PhotoFetchError);
  assert.equal(fetchImpl.calls.length, 0, 'nothing is fetched when the scheme is wrong');
});

test('a host not on the allowlist is refused', async () => {
  const fetchImpl = fakeFetch();
  await assert.rejects(() => safeFetch('https://evilcdn.example/a.jpg', { allowlist: ALLOW, fetchImpl, lookup: publicLookup }), /not on the photo allowlist/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('an empty allowlist refuses everything (fail closed)', async () => {
  await assert.rejects(() => safeFetch('https://cdn.tigren.com/a.jpg', { allowlist: [], fetchImpl: fakeFetch(), lookup: publicLookup }), /allowlist/);
});

test('a subdomain of an allowlisted host is allowed; a look-alike suffix is not', async () => {
  const fetchImpl = fakeFetch();
  const res = await safeFetch('https://media.cdn.tigren.com/a.jpg', { allowlist: ALLOW, fetchImpl, lookup: publicLookup });
  assert.equal(res.ext, 'jpg');
  // "evilcdn.tigren.com.bad" must NOT match "cdn.tigren.com".
  await assert.rejects(() => safeFetch('https://cdn.tigren.com.bad/a.jpg', { allowlist: ALLOW, fetchImpl: fakeFetch(), lookup: publicLookup }), /allowlist/);
});

test('a host that resolves to a private/loopback address is refused (SSRF inward)', async () => {
  for (const addr of ['127.0.0.1', '10.0.0.5', '192.168.1.9', '169.254.1.1', '::1']) {
    const fetchImpl = fakeFetch();
    await assert.rejects(
      () => safeFetch('https://cdn.tigren.com/a.jpg', { allowlist: ALLOW, fetchImpl, lookup: async () => [{ address: addr }] }),
      /private address/,
      `expected ${addr} to be refused`,
    );
    assert.equal(fetchImpl.calls.length, 0, `no fetch for ${addr}`);
  }
});

test('a non-image content-type is refused', async () => {
  const fetchImpl = fakeFetch({ contentType: 'text/html' });
  await assert.rejects(() => safeFetch('https://cdn.tigren.com/a.jpg', { allowlist: ALLOW, fetchImpl, lookup: publicLookup }), /non-image content-type/);
});

test('a body over the size cap is refused', async () => {
  const big = Buffer.alloc(200, 0xff);
  await assert.rejects(
    () => safeFetch('https://cdn.tigren.com/a.jpg', { allowlist: ALLOW, maxBytes: 100, fetchImpl: fakeFetch({ body: big }), lookup: publicLookup }),
    /exceeds/,
  );
});

test('a non-2xx response is refused', async () => {
  await assert.rejects(() => safeFetch('https://cdn.tigren.com/a.jpg', { allowlist: ALLOW, fetchImpl: fakeFetch({ status: 404 }), lookup: publicLookup }), /HTTP 404/);
});

test('the happy path returns bytes + an extension from the content-type, and sends NO auth header', async () => {
  for (const [ct, ext] of [['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']]) {
    const fetchImpl = fakeFetch({ contentType: ct });
    const res = await safeFetch('https://cdn.tigren.com/a', { allowlist: ALLOW, fetchImpl, lookup: publicLookup });
    assert.equal(res.ext, ext);
    assert.equal(res.contentType, ct);
    assert.ok(res.buffer.length > 0);
    // The CDN is public — the Shopify token must never be attached to this request (token-exfil guard).
    const headers = fetchImpl.calls[0].opts?.headers ?? {};
    assert.equal(Object.keys(headers).length, 0, 'no headers — certainly no X-Shopify-Access-Token — cross to the CDN');
    assert.equal(fetchImpl.calls[0].opts?.redirect, 'error', 'redirects are not followed (a 30x could bounce off-allowlist)');
  }
});
