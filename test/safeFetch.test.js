import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeFetch, PhotoFetchError } from '../src/shopify/safeFetch.js';

// safeFetch is the autopilot's SSRF / token-exfil boundary (U3 acceptance criterion): the photo URL is
// order-supplied data, so an unconstrained server-side fetch of it could hit localhost/internal hosts
// or leak a credential. Everything here drives it with an injected fetch + DNS so no packet ever leaves.

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.from('RIFF\0\0\0\0WEBP', 'binary');
// 32x32 HEVC-backed HEIF corpus image from libheif (LGPL-3.0 test corpus).
const HEIC = Buffer.from('AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAXttZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABnwABAAAAAAAAAGwAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAA+2lwcnAAAADbaXBjbwAAAHZodmNDAQNwAAAAAAAAAAAAHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQAqQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbq5Ka5uAhoMCAAAAMDIAAAAwAhYgABAAZEAcFzwIkAAAATY29scm5jbHgAAQANAAaAAAAAFGlzcGUAAAAAAAAAQAAAAEAAAAAoY2xhcAAAACAAAAABAAAAIAAAAAH////gAAAAAv///+AAAAACAAAADnBpeGkAAAAAAQgAAAAYaXBtYQAAAAAAAAABAAEFgQIDBYQAAAB0bWRhdAAAAGgoAa8TgPUrAhGDczL1mz4HCRRzxqbGjnnUrr1cLTO799zRz6nw0QjRMp+4I2Da10D3ghQEMvB53CWoI0S3qXIb99YsvLFaQ9ZLHxsJsZ9SxlvNJ5EgD4Y4miuaKu3bxPGXDHirp/9TzA==', 'base64');
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

test('image bytes, not a misleading MIME type or filename, determine the format', async () => {
  const heic = await safeFetch('https://cdn.tigren.com/photo.jpg?name=photo.jpg', {
    allowlist: ALLOW,
    fetchImpl: fakeFetch({ contentType: 'image/jpeg', body: HEIC }),
    lookup: publicLookup,
  });
  assert.equal(heic.ext, 'heic', 'HEIC bytes must never be passed downstream as JPEG');

  const jpeg = await safeFetch('https://cdn.tigren.com/photo.HEIC', {
    allowlist: ALLOW,
    fetchImpl: fakeFetch({ contentType: 'image/heic', body: JPEG }),
    lookup: publicLookup,
  });
  assert.equal(jpeg.ext, 'jpg', 'a misleading extension must not override JPEG bytes');
});

test('HTML mislabeled as an image is rejected at the download boundary', async () => {
  await assert.rejects(
    () => safeFetch('https://cdn.tigren.com/expired.jpg', {
      allowlist: ALLOW,
      fetchImpl: fakeFetch({ contentType: 'image/jpeg', body: Buffer.from('<!doctype html><title>expired</title>') }),
      lookup: publicLookup,
    }),
    /image bytes/,
  );
});

test('a body over the size cap is refused', async () => {
  const big = Buffer.alloc(200, 0xff);
  await assert.rejects(
    () => safeFetch('https://cdn.tigren.com/a.jpg', { allowlist: ALLOW, maxBytes: 100, fetchImpl: fakeFetch({ body: big }), lookup: publicLookup }),
    /exceeds/,
  );
});

test('the timeout remains active while a response body stalls', async () => {
  const fetchImpl = async (_url, { signal }) => ({
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
    body: { getReader: () => ({
      read: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
      cancel: async () => {},
    }) },
  });
  await assert.rejects(
    () => safeFetch('https://cdn.tigren.com/stalled.jpg', { allowlist: ALLOW, fetchImpl, lookup: publicLookup, timeoutMs: 10 }),
    /timeout|timed out/i,
  );
});

test('a non-2xx response is refused', async () => {
  await assert.rejects(() => safeFetch('https://cdn.tigren.com/a.jpg', { allowlist: ALLOW, fetchImpl: fakeFetch({ status: 404 }), lookup: publicLookup }), /HTTP 404/);
});

// Order 1564 shipped a 3-photo book from a 4-photo order: the CDN's Cloudflare edge answered one
// photo with a 403 challenge. A 403 there is transient, so it must be retried, not treated as fatal.
test('a 403 challenge from the CDN is retried until it lets us through', async () => {
  const statuses = [403, 403, 200];
  let i = 0;
  const fetchImpl = async () => {
    const status = statuses[i++];
    return {
      ok: status === 200,
      status,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.byteLength),
    };
  };
  const res = await safeFetch('https://cdn.tigren.com/a.jpg', { allowlist: ALLOW, fetchImpl, lookup: publicLookup, sleep: async () => {} });
  assert.equal(res.ext, 'jpg');
  assert.equal(i, 3, 'gave up too early or retried too much');
});

test('a persistent 403 still fails, after the retries', async () => {
  const fetchImpl = fakeFetch({ status: 403 });
  await assert.rejects(
    () => safeFetch('https://cdn.tigren.com/a.jpg', { allowlist: ALLOW, fetchImpl, lookup: publicLookup, attempts: 3, sleep: async () => {} }),
    /HTTP 403 after 3 attempt/,
  );
  assert.equal(fetchImpl.calls.length, 3);
});

test('a 404 is NOT retried — the photo is genuinely gone', async () => {
  const fetchImpl = fakeFetch({ status: 404 });
  await assert.rejects(() => safeFetch('https://cdn.tigren.com/a.jpg', { allowlist: ALLOW, fetchImpl, lookup: publicLookup, sleep: async () => {} }), /HTTP 404/);
  assert.equal(fetchImpl.calls.length, 1);
});

test('the happy path returns bytes + an extension from the content-type, and sends NO auth header', async () => {
  for (const [ct, ext, body] of [['image/jpeg', 'jpg', JPEG], ['image/png', 'png', PNG], ['image/webp', 'webp', WEBP]]) {
    const fetchImpl = fakeFetch({ contentType: ct, body });
    const res = await safeFetch('https://cdn.tigren.com/a', { allowlist: ALLOW, fetchImpl, lookup: publicLookup });
    assert.equal(res.ext, ext);
    assert.equal(res.contentType, ct);
    assert.ok(res.buffer.length > 0);
    // The CDN is public — the Shopify token must never be attached to this request (token-exfil guard).
    // A User-Agent is sent (Cloudflare 403s a UA-less request); nothing that could carry a credential is.
    const headers = fetchImpl.calls[0].opts?.headers ?? {};
    assert.deepEqual(Object.keys(headers), ['User-Agent'], 'only a User-Agent — no X-Shopify-Access-Token — crosses to the CDN');
    assert.equal(fetchImpl.calls[0].opts?.redirect, 'error', 'redirects are not followed (a 30x could bounce off-allowlist)');
  }
});
