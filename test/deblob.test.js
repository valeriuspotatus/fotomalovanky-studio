import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deblob } from '../src/deblob.js';
import { measureSolidFill } from '../src/qc.js';

/** A 400x400 page: a big solid-black rectangle (a shadow blob), a tiny black square (an eye), on white,
 *  plus a matching SVG — a black FILL over the big rect, a black FILL over the eye, and a black STROKE. */
async function page(dir) {
  const big = await sharp({ create: { width: 120, height: 120, channels: 3, background: '#000000' } }).png().toBuffer();
  const eye = await sharp({ create: { width: 6, height: 6, channels: 3, background: '#000000' } }).png().toBuffer();
  const png = join(dir, 'p_bw.png');
  await sharp({ create: { width: 400, height: 400, channels: 3, background: '#ffffff' } })
    .composite([{ input: big, left: 40, top: 40 }, { input: eye, left: 320, top: 320 }])
    .png()
    .toFile(png);
  const svg = join(dir, 'p.svg');
  writeFileSync(
    svg,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0.00 0.00 400.00 400.00">
<path fill="#000000" d="M40 40 L160 40 L160 160 L40 160 Z"/>
<path fill="#000000" d="M320 320 L326 320 L326 326 L320 326 Z"/>
<path fill="none" stroke="#000000" d="M0 200 L400 200"/>
</svg>`,
  );
  return { png, svg };
}

async function solidFill(png) {
  const { data, info } = await sharp(readFileSync(png)).grayscale().raw().toBuffer({ resolveWithObject: true });
  return measureSolidFill(data, info.width, info.height).solidFill;
}

test('deblob whitens the big black mass in raster AND svg, keeps the small fill and the strokes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-deblob-'));
  try {
    const { png, svg } = await page(dir);
    const before = await solidFill(png);
    const r = await deblob({ pngPath: png, svgPath: svg });
    assert.equal(r.cleaned, true);

    // Raster: the big mass is gone…
    const after = await solidFill(png);
    assert.ok(after < before * 0.35, `the big mass is cleared: ${(before * 100).toFixed(2)}% -> ${(after * 100).toFixed(2)}%`);
    // …but the tiny eye is still black.
    const eyePx = await sharp(readFileSync(png)).extract({ left: 320, top: 320, width: 6, height: 6 }).grayscale().raw().toBuffer();
    assert.ok([...eyePx].some((v) => v < 128), 'the small black fill (the eye) survives');

    // SVG: the big FILL path is hollowed to none; the eye fill and the stroke are untouched.
    const out = readFileSync(svg, 'utf8');
    assert.match(out, /fill="none" d="M40 40/, 'the big blob fill is switched to none, so the print is not black there');
    assert.match(out, /fill="#000000" d="M320 320/, 'the small fill keeps its black');
    assert.match(out, /stroke="#000000" d="M0 200/, 'outline strokes are never touched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a page with no big black mass is left untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-deblob-'));
  try {
    const png = join(dir, 'p_bw.png');
    // only a thin line and a tiny square — nothing solid enough to be a blob
    const eye = await sharp({ create: { width: 6, height: 6, channels: 3, background: '#000000' } }).png().toBuffer();
    await sharp({ create: { width: 400, height: 400, channels: 3, background: '#ffffff' } }).composite([{ input: eye, left: 100, top: 100 }]).png().toFile(png);
    const r = await deblob({ pngPath: png });
    assert.deepEqual(r, { cleaned: false, reason: 'no-large-blobs' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
