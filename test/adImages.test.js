import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateAdImages, describeAndGenerate, toDataUri, AdImageError } from '../src/creatives/adImages.js';

// The orchestrator keeps the two external calls (Nano Banana "before", RunPod line-art "after")
// behind injected functions, so its logic is verifiable with stubs — no network, no GPU.

test('generateAdImages runs the before, then feeds it to the after step', async () => {
  const calls = [];
  const aiFn = async (a) => { calls.push(['ai', a.prompt, a.referenceBase64]); return { base64: 'BEFORE', mimeType: 'image/png' }; };
  const lineArtFn = async (img) => { calls.push(['line', img.base64]); return { base64: 'AFTER', mimeType: 'image/png' }; };

  const out = await generateAdImages({ referenceBase64: 'REF', referenceMime: 'image/jpeg', prompt: 'a scene', aiFn, lineArtFn });

  assert.deepEqual(out, { before: { base64: 'BEFORE', mimeType: 'image/png' }, after: { base64: 'AFTER', mimeType: 'image/png' } });
  assert.deepEqual(calls, [['ai', 'a scene', 'REF'], ['line', 'BEFORE']], 'the after step receives the generated before image');
});

test('generateAdImages rejects a missing prompt or missing steps', async () => {
  await assert.rejects(() => generateAdImages({ prompt: '', aiFn: () => {}, lineArtFn: () => {} }), (e) => e instanceof AdImageError && e.code === 'bad-input');
  await assert.rejects(() => generateAdImages({ prompt: 'x' }), (e) => e instanceof AdImageError && e.code === 'bad-input');
});

test('generateAdImages surfaces an empty result from either step as no-image', async () => {
  await assert.rejects(
    () => generateAdImages({ prompt: 'x', aiFn: async () => ({}), lineArtFn: async () => ({ base64: 'A' }) }),
    (e) => e instanceof AdImageError && e.code === 'no-image',
  );
  await assert.rejects(
    () => generateAdImages({ prompt: 'x', aiFn: async () => ({ base64: 'B' }), lineArtFn: async () => ({}) }),
    (e) => e instanceof AdImageError && e.code === 'no-image',
  );
});

test('describeAndGenerate describes the photo, then generates from that text WITHOUT the photo', async () => {
  const calls = [];
  const describeFn = async (a) => { calls.push(['describe', a.referenceBase64, a.referenceMime]); return '  a warm generic scene  '; };
  const aiFn = async (a) => { calls.push(['ai', a.prompt, a.referenceBase64]); return { base64: 'BEFORE', mimeType: 'image/png' }; };
  const lineArtFn = async (img) => { calls.push(['line', img.base64]); return { base64: 'AFTER', mimeType: 'image/png' }; };

  const out = await describeAndGenerate({ referenceBase64: 'CUSTOMER', referenceMime: 'image/png', describeFn, aiFn, lineArtFn });

  assert.deepEqual(out, {
    before: { base64: 'BEFORE', mimeType: 'image/png' },
    after: { base64: 'AFTER', mimeType: 'image/png' },
    prompt: 'a warm generic scene',
  }, 'the trimmed described prompt is returned alongside the images');
  // The photo reaches the describe step, but the image step must receive referenceBase64:null — the
  // privacy invariant that the customer's pixels never touch the image model.
  assert.deepEqual(calls, [['describe', 'CUSTOMER', 'image/png'], ['ai', 'a warm generic scene', null], ['line', 'BEFORE']]);
});

test('describeAndGenerate rejects a missing photo, missing describeFn, or an empty description', async () => {
  await assert.rejects(() => describeAndGenerate({ describeFn: () => 'x', aiFn: () => {}, lineArtFn: () => {} }), (e) => e instanceof AdImageError && e.code === 'bad-input');
  await assert.rejects(() => describeAndGenerate({ referenceBase64: 'R', aiFn: () => {}, lineArtFn: () => {} }), (e) => e instanceof AdImageError && e.code === 'bad-input');
  await assert.rejects(
    () => describeAndGenerate({ referenceBase64: 'R', describeFn: async () => '   ', aiFn: async () => ({ base64: 'B' }), lineArtFn: async () => ({ base64: 'A' }) }),
    (e) => e instanceof AdImageError && e.code === 'no-image',
  );
});

test('toDataUri formats an image, defaulting the mime to png', () => {
  assert.equal(toDataUri({ base64: 'ZZ', mimeType: 'image/jpeg' }), 'data:image/jpeg;base64,ZZ');
  assert.equal(toDataUri({ base64: 'ZZ' }), 'data:image/png;base64,ZZ');
});
