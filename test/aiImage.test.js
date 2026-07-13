import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMarketingImage, describeImage, DESCRIBE_INSTRUCTION, AiImageError } from '../src/creatives/aiImage.js';

// The adapter is the one seam that calls Gemini ("Nano Banana Pro"). These exercise its logic —
// request shape, response parsing, and every error path — with an injected fetch, so the suite
// stays offline. The live call is verified against the real API once the key is in config.json.

const CONFIG = { apiKey: 'test-key', model: 'gemini-3-pro-image-preview', endpoint: 'https://gen.example/v1beta', timeoutMs: 5000, backoffBaseMs: 0 };

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

test('image generation uses its own imageTimeoutMs, not the shorter describe timeout', async () => {
  // imageTimeoutMs is tiny and timeoutMs is huge; a fetch that only settles when its signal aborts
  // (like real fetch) must be aborted by the SHORT image budget (code 'timeout'). If it wrongly used
  // the long timeoutMs, this would take ~100s — the test's own guard would fail first.
  const abortable = (url, opts) =>
    new Promise((_, reject) => {
      opts.signal?.addEventListener('abort', () => {
        const e = new Error('This operation was aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  await assert.rejects(
    () => generateMarketingImage({ config: { ...CONFIG, timeoutMs: 100000, imageTimeoutMs: 30, maxRetries: 0 }, prompt: 'x', fetchImpl: abortable }),
    (e) => e instanceof AiImageError && e.code === 'timeout',
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

test('a transient 503 overload is retried and recovers on a later attempt', async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) return { ok: false, status: 503, text: async () => 'high demand' };
    return okImage('OK64', 'image/png');
  };
  const out = await generateMarketingImage({ config: CONFIG, prompt: 'p', fetchImpl: flaky });
  assert.deepEqual(out, { base64: 'OK64', mimeType: 'image/png' });
  assert.equal(calls, 3, 'two 503s were retried, the third attempt succeeded');
});

test('a 503 that never clears exhausts retries and surfaces a clear overload error', async () => {
  let calls = 0;
  const down = async () => { calls++; return { ok: false, status: 503, text: async () => 'high demand' }; };
  await assert.rejects(
    () => generateMarketingImage({ config: CONFIG, prompt: 'p', fetchImpl: down }),
    (e) => e instanceof AiImageError && e.code === 'api' && /přetížený/.test(e.message),
  );
  assert.equal(calls, 4, 'initial attempt + 3 retries');
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

// --- describeImage: photo -> identity-free text prompt (the vision half of describe-then-generate) ---

const okText = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });

test('describeImage targets the describeModel, sends the photo + instruction, returns the trimmed text', async () => {
  const cap = {};
  const cfg = { ...CONFIG, describeModel: 'gemini-2.5-flash' };
  const out = await describeImage({ config: cfg, referenceBase64: 'PHOTO64', referenceMime: 'image/png', fetchImpl: fakeFetch(okText('  a cosy family scene  '), cap) });
  assert.equal(out, 'a cosy family scene');
  assert.equal(cap.url, 'https://gen.example/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(cap.opts.headers['x-goog-api-key'], 'test-key');
  assert.equal(cap.body.contents[0].parts[0].text, DESCRIBE_INSTRUCTION, 'the default privacy instruction is sent');
  const inline = cap.body.contents[0].parts.find((p) => p.inlineData);
  assert.equal(inline.inlineData.data, 'PHOTO64');
  assert.equal(inline.inlineData.mimeType, 'image/png');
  assert.ok(!cap.body.generationConfig, 'no IMAGE responseModalities on the describe call');
});

test('describeImage honours a per-call instruction override and config.describeInstruction', async () => {
  const cap = {};
  await describeImage({ config: CONFIG, referenceBase64: 'P', instruction: 'CUSTOM ONE', fetchImpl: fakeFetch(okText('x'), cap) });
  assert.equal(cap.body.contents[0].parts[0].text, 'CUSTOM ONE');
  const cap2 = {};
  await describeImage({ config: { ...CONFIG, describeInstruction: 'FROM CONFIG' }, referenceBase64: 'P', fetchImpl: fakeFetch(okText('x'), cap2) });
  assert.equal(cap2.body.contents[0].parts[0].text, 'FROM CONFIG');
});

test('describeImage refuses without a key or a reference photo, and maps errors', async () => {
  await assert.rejects(() => describeImage({ config: {}, referenceBase64: 'P' }), (e) => e instanceof AiImageError && e.code === 'not-configured');
  await assert.rejects(() => describeImage({ config: CONFIG, referenceBase64: '' }), (e) => e instanceof AiImageError && e.code === 'bad-input');
  const empty = { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [] } }], promptFeedback: { blockReason: 'SAFETY' } }) };
  await assert.rejects(
    () => describeImage({ config: CONFIG, referenceBase64: 'P', fetchImpl: async () => empty }),
    (e) => e instanceof AiImageError && e.code === 'no-image' && /SAFETY/.test(e.message),
  );
  const authRes = { ok: false, status: 401, text: async () => 'nope' };
  await assert.rejects(
    () => describeImage({ config: CONFIG, referenceBase64: 'P', fetchImpl: async () => authRes }),
    (e) => e instanceof AiImageError && e.code === 'auth',
  );
});
