import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { autoCropColoring, contentBox, deframe } from '../src/autoCrop.js';

/** Write a WxH white PNG with a black rectangle of ink, mimicking a coloring page. */
async function inkPng(path, W, H, rect) {
  const buf = Buffer.alloc(W * H, 255);
  for (let y = rect.top; y < rect.top + rect.height; y++)
    for (let x = rect.left; x < rect.left + rect.width; x++) buf[y * W + x] = 0;
  await sharp(buf, { raw: { width: W, height: H, channels: 1 } }).png().toFile(path);
}

/** Write a WxH white PNG with a solid black keyline border `t` px thick, plus an interior ink block. */
async function borderedPng(path, W, H, t, inner) {
  const buf = Buffer.alloc(W * H, 255);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) if (x < t || x >= W - t || y < t || y >= H - t) buf[y * W + x] = 0;
  for (let y = inner.top; y < inner.top + inner.height; y++)
    for (let x = inner.left; x < inner.left + inner.width; x++) buf[y * W + x] = 0;
  await sharp(buf, { raw: { width: W, height: H, channels: 1 } }).png().toFile(path);
}

const svgOf = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0.00 0.00 ${w}.00 ${h}.00"><path d="M0 0"/></svg>`;

test('deframe crops a solid black border keyline off both the PNG and the SVG', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-deframe-'));
  try {
    const png = join(dir, 'p_bw.png'), svg = join(dir, 'p.svg');
    await borderedPng(png, 400, 300, 4, { left: 150, top: 110, width: 100, height: 80 });
    writeFileSync(svg, svgOf(400, 300));

    const res = await deframe({ pngPath: png, svgPath: svg });
    assert.equal(res.deframed, true);

    const m = await sharp(png).metadata();
    assert.ok(m.width < 400 && m.width >= 380, `width lost the border (got ${m.width})`);
    assert.ok(m.height < 300 && m.height >= 280, `height lost the border (got ${m.height})`);

    // The new perimeter is clean paper — the keyline is gone, not just hidden.
    const { data, info } = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
    let topEdgeInk = 0;
    for (let x = 0; x < info.width; x++) if (data[x] < 120) topEdgeInk++;
    assert.equal(topEdgeInk, 0, 'top edge is clean paper after deframe');

    const vb = readFileSync(svg, 'utf8').match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
    assert.ok(vb[0] >= 4 && vb[0] <= 6, `viewBox x moved past the border (got ${vb[0]})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deframe leaves a normal borderless page untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-deframe-'));
  try {
    const png = join(dir, 'p_bw.png'), svg = join(dir, 'p.svg');
    await inkPng(png, 300, 300, { left: 60, top: 60, width: 180, height: 180 });
    writeFileSync(svg, svgOf(300, 300));
    const res = await deframe({ pngPath: png, svgPath: svg });
    assert.equal(res.deframed, false);
    assert.equal((await sharp(png).metadata()).width, 300, 'no-frame page untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
