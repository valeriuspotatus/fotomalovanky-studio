import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMarketingImage, AiImageError } from '../src/creatives/aiImage.js';

// The adapter is the one seam that calls Gemini ("Nano Banana Pro"). These exercise its logic —
// request shape, response parsing, and every error path — with an injected fetch, so the suite
// stays offline. The live call is verified against the real API once the key is in config.json.

const CONFIG = { apiKey: 'test-key', model: 'gemini-3-pro-image-preview', endpoint: 'https://gen.example/v1beta', timeoutMs: 5000 };

/** A fake fetch that records the call and returns a canned Response-like object. */
function fakeFetch(response, capture = {}) {
  return async (url, opts) => {
    capture.url = url;
    capture.opts = opts;
    capture.body = JSON.parse(opts.body);
    return response;
  };
}
const okImage = (data = 'AAAA', mimeType = 'image/png') => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }] }),
});

test('generateMarketingImage refuses without an API key or a prompt', async () => {
  await assert.rejects(
    () => generateMarketingImage({ config: {}, prompt: 'x' }),
    (e) => e instanceof AiImageError && e.code === 'not-configured',
  );
  await assert.rejects(
    () => generateMarketingImage({ config: CONFIG, prompt: '  ' }),
    (e) => e instanceof AiImageError && e.code === 'bad-input',
  );
});

test('generateMarketingImage returns the generated image and targets the configured model', async () => {
  const cap = {};
  const out = await generateMarketingImage({ config: CONFIG, prompt: 'radostná rodina', fetchImpl: fakeFetch(okImage('ZZZZ', 'image/jpeg'), cap) });
  assert.deepEqual(out, { base64: 'ZZZZ', mimeType: 'image/jpeg' });
  assert.equal(cap.url, 'https://gen.example/v1beta/models/gemini-3-pro-image-preview:generateContent');
  assert.equal(cap.opts.headers['x-goog-api-key'], 'test-key');
  assert.equal(cap.body.contents[0].parts[0].text, 'radostná rodina');
});

test('a reference photo is attached as inlineData when supplied', async () => {
  const cap = {};
  await generateMarketingImage({ config: CONFIG, prompt: 'p', referenceBase64: 'REF64', referenceMime: 'image/webp', fetchImpl: fakeFetch(okImage(), cap) });
  const inline = cap.body.contents[0].parts.find((p) => p.inlineData);
  assert.equal(inline.inlineData.data, 'REF64');
  assert.equal(inline.inlineData.mimeType, 'image/webp');
});

test('text-to-image sends no inlineData when there is no reference', async () => {
  const cap = {};
  await generateMarketingImage({ config: CONFIG, prompt: 'p', fetchImpl: fakeFetch(okImage(), cap) });
  assert.ok(!cap.body.contents[0].parts.some((p) => p.inlineData), 'no image part without a reference');
});

test('an auth failure maps to the auth code, other HTTP errors to api', async () => {
  const authRes = { ok: false, status: 403, text: async () => 'permission denied' };
  await assert.rejects(
    () => generateMarketingImage({ config: CONFIG, prompt: 'p', fetchImpl: async () => authRes }),
    (e) => e instanceof AiImageError && e.code === 'auth',
  );
  const serverRes = { ok: false, status: 500, text: async () => 'boom' };
  await assert.rejects(
    () => generateMarketingImage({ config: CONFIG, prompt: 'p', fetchImpl: async () => serverRes }),
    (e) => e instanceof AiImageError && e.code === 'api',
  );
});

test('a response with no image part is a no-image error, surfacing the model note', async () => {
  const blocked = { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'blocked for safety' }] } }] }) };
  await assert.rejects(
    () => generateMarketingImage({ config: CONFIG, prompt: 'p', fetchImpl: async () => blocked }),
    (e) => e instanceof AiImageError && e.code === 'no-image' && /blocked for safety/.test(e.message),
  );
});

test('an aborted request maps to a timeout error', async () => {
  const abort = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  await assert.rejects(
    () => generateMarketingImage({ config: CONFIG, prompt: 'p', fetchImpl: abort }),
    (e) => e instanceof AiImageError && e.code === 'timeout',
  );
});
