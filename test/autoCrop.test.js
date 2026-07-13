import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { autoCropColoring, contentBox } from '../src/autoCrop.js';

/** Write a WxH white PNG with a black rectangle of ink, mimicking a coloring page. */
async function inkPng(path, W, H, rect) {
  const buf = Buffer.alloc(W * H, 255);
  for (let y = rect.top; y < rect.top + rect.height; y++)
    for (let x = rect.left; x < rect.left + rect.width; x++) buf[y * W + x] = 0;
  await sharp(buf, { raw: { width: W, height: H, channels: 1 } }).png().toFile(path);
}

const svgOf = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0.00 0.00 ${w}.00 ${h}.00"><path d="M0 0"/></svg>`;

test('a subject marooned in white is cropped to its ink, and the SVG viewBox follows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-crop-'));
  try {
    const png = join(dir, 'p_bw.png'), svg = join(dir, 'p.svg');
    // 400x400 page, ink only in a 100x100 block far from the edges: mostly white.
    await inkPng(png, 400, 400, { left: 150, top: 120, width: 100, height: 100 });
    writeFileSync(svg, svgOf(400, 400));

    const res = await autoCropColoring({ pngPath: png, svgPath: svg });
    assert.equal(res.cropped, true);
    assert.ok(res.kept < 0.3, 'most of the white page was trimmed away');

    // The PNG is now roughly the ink block (plus a small margin), not the full 400x400.
    const m = await sharp(png).metadata();
    assert.ok(m.width < 160 && m.width >= 100, `width tightened to the ink (got ${m.width})`);
    assert.ok(m.height < 160 && m.height >= 100, `height tightened to the ink (got ${m.height})`);

    // The SVG viewBox moved to the crop box (no longer the full 0 0 400 400).
    const vb = readFileSync(svg, 'utf8').match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
    assert.ok(vb[0] >= 130 && vb[0] <= 150, `viewBox x at the ink (got ${vb[0]})`);
    assert.ok(vb[2] < 160 && vb[2] >= 100, `viewBox width tightened (got ${vb[2]})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a page whose ink already reaches the edges is left untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-crop-'));
  try {
    const png = join(dir, 'p_bw.png'), svg = join(dir, 'p.svg');
    // Ink spans almost the whole frame → nothing meaningful to trim.
    await inkPng(png, 300, 300, { left: 4, top: 4, width: 292, height: 292 });
    writeFileSync(svg, svgOf(300, 300));

    const res = await autoCropColoring({ pngPath: png, svgPath: svg });
    assert.equal(res.cropped, false, 'a full-frame page is not cropped');
    const m = await sharp(png).metadata();
    assert.equal(m.width, 300, 'PNG untouched');
    assert.match(readFileSync(svg, 'utf8'), /viewBox="0\.00 0\.00 300\.00 300\.00"/, 'SVG untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a blank page is never cropped to nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-crop-'));
  try {
    const png = join(dir, 'p_bw.png');
    await sharp(Buffer.alloc(200 * 200, 255), { raw: { width: 200, height: 200, channels: 1 } }).png().toFile(png);
    assert.equal(await contentBox(png), null);
    assert.deepEqual(await autoCropColoring({ pngPath: png, svgPath: null }), { cropped: false, reason: 'blank' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
