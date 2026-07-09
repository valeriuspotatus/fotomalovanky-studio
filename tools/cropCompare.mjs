// Zoom every generation in an A/B run to the same region and stack them into one labelled
// strip. Some defects (eyes drawn behind sunglass lenses) are invisible to any pixel metric
// and to a full-page thumbnail — they only show up zoomed, side by side.
//
//   node tools/cropCompare.mjs --dir outbox/ab2 --box 0.27,0.56,0.59,0.73 [--ref <png>] [--out crops.png]
//
// --box is x0,y0,x1,y1 as fractions of width/height, so it survives resolution changes.

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const dir = resolve(flag('--dir', 'outbox/ab2'));
const [x0, y0, x1, y1] = flag('--box', '0.27,0.56,0.59,0.73').split(',').map(Number);
const ref = flag('--ref', null);
const refLabel = flag('--ref-label', 'REFERENCE');
const outPath = join(dir, flag('--out', 'crops.png'));
const TILE_W = 620;

function bwIn(d) {
  if (!existsSync(d)) return null;
  const f = readdirSync(d).find((x) => x.endsWith('_bw.png'));
  return f ? join(d, f) : null;
}

async function cropOf(src, label) {
  const m = await sharp(src).metadata();
  const left = Math.round(x0 * m.width);
  const top = Math.round(y0 * m.height);
  const width = Math.round((x1 - x0) * m.width);
  const height = Math.round((y1 - y0) * m.height);
  const body = await sharp(src)
    .extract({ left, top, width, height })
    .resize({ width: TILE_W })
    .toBuffer();
  const bh = (await sharp(body).metadata()).height;
  const BAR = 34;
  const svg = Buffer.from(
    `<svg width="${TILE_W}" height="${BAR}"><rect width="100%" height="100%" fill="#111"/><text x="10" y="23" font-family="sans-serif" font-size="17" fill="#fff">${label}</text></svg>`,
  );
  return sharp({ create: { width: TILE_W, height: bh + BAR, channels: 3, background: '#fff' } })
    .composite([{ input: svg, top: 0, left: 0 }, { input: body, top: BAR, left: 0 }])
    .png()
    .toBuffer();
}

const tiles = [];
if (ref) tiles.push(await cropOf(resolve(ref), refLabel));

const CELL = /__([A-Za-z0-9]+)-r(\d)$/;
const cells = readdirSync(dir)
  .filter((d) => CELL.test(d))
  .sort((a, b) => a.match(CELL)[1].localeCompare(b.match(CELL)[1]) || a.localeCompare(b));

// Cell -> human label comes from results.json when present, so the strip says what was actually run.
let labels = {};
try {
  for (const r of JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'))) labels[r.config] ??= r.label;
} catch {
  /* labels are a nicety; fall back to the raw cell id */
}

for (const c of cells) {
  const src = bwIn(join(dir, c));
  if (!src) continue;
  const [, id, rep] = c.match(CELL);
  tiles.push(await cropOf(src, `${id} · rep ${rep} — ${labels[id] ?? 'unknown config'}`));
}

if (!tiles.length) {
  console.error('No generations found in', dir);
  process.exit(1);
}

const metas = await Promise.all(tiles.map((t) => sharp(t).metadata()));
const totalH = metas.reduce((s, m) => s + m.height + 6, 0);
let top = 0;
const composite = tiles.map((t, i) => {
  const c = { input: t, top, left: 0 };
  top += metas[i].height + 6;
  return c;
});

await sharp({ create: { width: TILE_W, height: totalH, channels: 3, background: '#666' } })
  .composite(composite)
  .png()
  .toFile(outPath);
console.log(`wrote ${outPath} (${tiles.length} tiles)`);
