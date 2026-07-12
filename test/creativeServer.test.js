import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewServer } from '../src/ui/server.js';

// The Kreativy studio's AI-image seam — POST /api/creative/ai-image — generates the ad's "before"
// (Nano Banana Pro) + "after" (RunPod line-art), caches the pair, and hands back a short id the
// layered preview references via ?images=<id>. These tests drive it with an injected fake so nothing
// touches the network or the GPU. The template engine itself is covered in creativeStudio.test.js.

const CONFIG = { generator: { baseUrl: 'https://example.test/tok/', mode: 'api' }, builder: { baseUrl: 'https://example.test' }, paths: { inbox: './inbox', outbox: './outbox' } };

async function withServer(run, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fma-creative-'));
  const inbox = join(root, 'inbox');
  const outbox = join(root, 'outbox');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(outbox, { recursive: true });
  const { server } = createReviewServer({ config: CONFIG, inboxRoot: inbox, outboxRoot: outbox, memoryRoot: outbox, driver: { generate: async () => {} }, ...extra });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(origin);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('POST /api/creative/ai-image reports not-configured when AI is off', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/api/creative/ai-image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'a scene' }) });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'not-configured');
  });
});

test('POST /api/creative/ai-image requires a prompt', async () => {
  const stub = async () => ({ before: { base64: 'B' }, after: { base64: 'A' } });
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/api/creative/ai-image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: '  ' }) });
    assert.equal(res.status, 400);
  }, { adImageFn: stub });
});

test('POST /api/creative/ai-image caches the pair; the studio preview references it by id', async () => {
  const stub = async ({ prompt, referenceBase64 }) => {
    assert.equal(prompt, 'a scene');
    assert.equal(referenceBase64, 'REF64');
    return { before: { base64: 'B64', mimeType: 'image/png' }, after: { base64: 'A64', mimeType: 'image/png' } };
  };
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/api/creative/ai-image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'a scene', referenceBase64: 'REF64' }) });
    assert.equal(res.status, 200);
    const { id, before, after } = await res.json();
    assert.ok(id, 'returns a cache id');
    assert.equal(before, 'data:image/png;base64,B64');
    assert.equal(after, 'data:image/png;base64,A64');

    // The layered preview pulls the pair into the template's original + coloring slots.
    const html = await (await fetch(`${origin}/studio/preview?template=promena&format=feed&images=${id}`)).text();
    assert.ok(html.includes('src="data:image/png;base64,B64"'), 'the before image fills the original slot');
    assert.ok(html.includes('src="data:image/png;base64,A64"'), 'the after image fills the coloring slot');
    assert.ok(!html.includes('původní fotka'), 'the slot placeholders are gone once real images are set');
  }, { adImageFn: stub });
});

test('POST /api/creative/ai-image auto mode requires a reference photo, not a prompt', async () => {
  const stub = async () => ({ before: { base64: 'B' }, after: { base64: 'A' } });
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/api/creative/ai-image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto: true }) });
    assert.equal(res.status, 400, 'auto with no photo is refused');
    assert.match((await res.json()).error, /nahrajte fotku/i);
  }, { adImageFn: stub });
});

test('POST /api/creative/ai-image auto mode describes then returns the AI prompt', async () => {
  const stub = async ({ auto, referenceBase64, prompt }) => {
    assert.equal(auto, true, 'the auto flag is forwarded to the generator');
    assert.equal(referenceBase64, 'PHOTO', 'the photo is forwarded to the describe step');
    assert.equal(prompt, undefined, 'no operator prompt is sent in auto mode');
    return { before: { base64: 'B64', mimeType: 'image/png' }, after: { base64: 'A64', mimeType: 'image/png' }, prompt: 'an identity-free scene' };
  };
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/api/creative/ai-image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto: true, referenceBase64: 'PHOTO', referenceMime: 'image/png' }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.id, 'returns a cache id');
    assert.equal(body.prompt, 'an identity-free scene', 'the described prompt is returned for the UI to show');
    assert.equal(body.before, 'data:image/png;base64,B64');
  }, { adImageFn: stub });
});

test('the studio preview never sources images from customer orders', async () => {
  await withServer(async (origin) => {
    // order/before params are not honoured: marketing imagery only ever comes from the AI seam.
    const html = await (await fetch(`${origin}/studio/preview?template=promena&format=feed&order=9999&before=nope`)).text();
    assert.ok(html.includes('původní fotka'), 'the original slot stays a placeholder');
    assert.ok(!html.includes('data:image/jpeg'), 'no order photo is embedded');
  });
});
