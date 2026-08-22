import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { assessPhotoFile } from '../src/inputQcFiles.js';

// One real round-trip through sharp: the adapter must read bytes, hash them, decode, and feed the
// pure heuristics. The pure numbers themselves are covered by inputQc.test.js; here we only prove
// the plumbing and the failure path.

test('assessPhotoFile reads, hashes and decodes a real image', async () => {
  const buf = await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .jpeg()
    .toBuffer();
  const path = join(tmpdir(), `fma-intake-${process.pid}.jpg`);
  await writeFile(path, buf);
  try {
    const r = await assessPhotoFile(path);
    assert.equal(r.readable, true);
    assert.equal(r.base, `fma-intake-${process.pid}`);
    assert.match(r.sha1, /^[a-f0-9]{40}$/);
    assert.equal(r.resolution.verdict, 'ok'); // 1.08 MP, short side 900
    assert.equal(r.blur.reason, 'blurry'); // a flat fill carries no detail
    assert.equal(r.hash.length, 64);
  } finally {
    await rm(path, { force: true });
  }
});

test('a missing file is unreadable, not a throw', async () => {
  const r = await assessPhotoFile(join(tmpdir(), 'fma-does-not-exist-9c3f.jpg'));
  assert.equal(r.readable, false);
  assert.equal(r.resolution.reason, 'unreadable');
  assert.equal(r.hash.length, 64);
});

test('HEIC remains countable but is held before generation in an unverified codec runtime', async () => {
  const path = join(tmpdir(), `fma-intake-${process.pid}.HEIC`);
  await writeFile(path, Buffer.from('synthetic-heic'));
  try {
    const r = await assessPhotoFile(path);
    assert.equal(r.readable, false);
    assert.equal(r.resolution.reason, 'unreadable');
  } finally { await rm(path, { force: true }); }
});

test('HEIC bytes mislabeled as JPEG are still held before generation', async () => {
  const path = join(tmpdir(), `fma-intake-${process.pid}-mislabeled.jpg`);
  const bytes = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheicmif1')]);
  await writeFile(path, bytes);
  try {
    const r = await assessPhotoFile(path);
    assert.equal(r.readable, false);
  } finally { await rm(path, { force: true }); }
});

test('extreme manual-image dimensions are held before expensive processing', async () => {
  const path = join(tmpdir(), `fma-intake-${process.pid}-tall.png`);
  const bytes = await sharp({ create: { width: 1, height: 12001, channels: 3, background: '#fff' } }).png().toBuffer();
  await writeFile(path, bytes);
  try {
    const r = await assessPhotoFile(path);
    assert.equal(r.readable, false);
  } finally { await rm(path, { force: true }); }
});
