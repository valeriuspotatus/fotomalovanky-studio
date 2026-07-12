import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewServer } from '../src/ui/server.js';

// The Kreativy studio's read endpoints — /api/creatives (the pickers) and /creative/preview (the
// live-preview HTML) — are pure and browser-free, so they belong in the offline suite. The one
// Playwright-backed route (/creative/render) is covered by tools/creativeSample.mjs, not here.

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

test('GET /api/creatives exposes the campaign/palette/format pickers', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/api/creatives`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.campaigns.length >= 3, 'campaigns are listed');
    assert.ok(body.campaigns.every((c) => c.key && c.title && c.headline), 'each campaign carries its copy');
    assert.deepEqual(body.formats.map((f) => f.key).sort(), ['square', 'story', 'wide']);
    assert.ok(body.palettes.includes('rainbow'));
    assert.equal(body.orders, undefined, 'customer-order photos are never exposed to the studio');
  });
});

test('GET /creative/preview embeds the real brand logo, not the drawn fallback', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/creative/preview?campaign=obecny`);
    const html = await res.text();
    assert.ok(html.includes('class="logo-img"'), 'the served logo image is used');
    assert.ok(html.includes('data:image/png;base64,'), 'the logo is embedded as a data URI');
  });
});

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

test('POST /api/creative/ai-image caches the pair; the preview references it by id', async () => {
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

    const html = await (await fetch(`${origin}/creative/preview?campaign=obecny&images=${id}`)).text();
    assert.ok(html.includes('src="data:image/png;base64,B64"'), 'the before image is injected into the ad');
    assert.ok(html.includes('src="data:image/png;base64,A64"'), 'the after image is injected into the ad');
    assert.ok(!html.includes('class="ph ph-before"'), 'the placeholders are gone once real images are set');
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

test('GET /creative/preview renders the ad HTML from the query, escaping the copy', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/creative/preview?campaign=obecny&format=story&headline=${encodeURIComponent('<b>Ahoj</b>')}&highlight=teď`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /^<!doctype html>/i);
    assert.ok(html.includes('height:1920px'), 'the story format sizes the canvas');
    assert.ok(html.includes('&lt;b&gt;Ahoj&lt;/b&gt;'), 'operator copy is escaped, not injected');
    assert.ok(!html.includes('<b>Ahoj</b>'), 'no raw markup slips through');
  });
});

test('GET /creative/preview never sources photos from orders — the frames stay placeholders', async () => {
  await withServer(async (origin) => {
    // order/before params are no longer honoured: marketing imagery never comes from customer orders.
    const res = await fetch(`${origin}/creative/preview?campaign=obecny&order=9999&before=nope`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('class="ph ph-before"'), 'the before frame is a placeholder');
    assert.ok(html.includes('class="ph ph-after"'), 'the after frame is a placeholder');
    // The only embedded image is the brand logo (PNG); no order photo (jpeg) is pulled in.
    assert.ok(!html.includes('data:image/jpeg'), 'no order photo is embedded');
  });
});
