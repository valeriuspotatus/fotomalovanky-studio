// Full-page comparison of every prompt cell in a run, one row per fixture photo.
//
//   node tools/cellSheet.mjs --dir outbox/ab6 [--origs outbox/u8] [--out compare.pdf]
//
// Every cell in a run is generated back-to-back on one worker, so cells are comparable to each
// other. Cells from *different* runs are not (see the determinism note in the U8 spike).

import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const dir = resolve(flag('--dir', 'outbox/ab6'));
const origs = resolve(flag('--origs', 'outbox/u8'));

const rows = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')).filter((r) => r.status === 'ok');
const labels = {};
for (const r of rows) labels[r.config] ??= r.label;
const cells = [...new Set(rows.map((r) => r.config))];
const photos = [...new Set(rows.map((r) => r.photo))];

const thumbs = join(dir, 'cmpthumbs');
mkdirSync(thumbs, { recursive: true });
async function thumb(src, name, width = 760) {
  const dest = join(thumbs, name);
  if (!existsSync(dest)) await sharp(src).resize({ width, withoutEnlargement: true }).jpeg({ quality: 86 }).toFile(dest);
  return `cmpthumbs/${name}`;
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

function findOriginal(photo) {
  const order = photo.split('_')[0];
  const d = join(origs, order);
  if (!existsSync(d)) return null;
  const f = readdirSync(d).find((x) => /\.jpe?g$/i.test(x) && !/_bw\./i.test(x));
  return f ? join(d, f) : null;
}

let body = '';
for (const photo of photos) {
  const cols = [];
  const orig = findOriginal(photo);
  if (orig) cols.push(`<figure><img src="${await thumb(orig, `${photo}_orig.jpg`)}"><figcaption><b>ORIGINAL PHOTO</b></figcaption></figure>`);
  for (const c of cells) {
    const r = rows.find((x) => x.photo === photo && x.config === c);
    if (!r) continue;
    const t = await thumb(r.coloringPngPath, `${photo}_${c}.jpg`);
    cols.push(
      `<figure><a href="${esc(r.coloringPngPath)}" target="_blank"><img src="${t}"></a>
       <figcaption><b>${esc(c)}</b> — ${esc(labels[c])}<br>ink ${(r.coverage * 100).toFixed(2)}% · ${r.svgPaths} paths</figcaption></figure>`,
    );
  }
  body += `<section class="card"><h2>${esc(photo)}</h2><div class="row" style="grid-template-columns:repeat(${cols.length},1fr)">${cols.join('')}</div></section>`;
}

const html = `<!doctype html><meta charset="utf-8"><title>Prompt cell comparison</title>
<style>
 body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;padding:22px;max-width:1900px;background:#fafafa;color:#111}
 h1{margin:0 0 6px} h2{font-size:15px;margin:0 0 10px;color:#444}
 .note{background:#fff8e1;border:1px solid #f0c36d;border-radius:8px;padding:11px 15px;margin:12px 0 20px}
 .card{background:#fff;border:1px solid #ddd;border-radius:9px;padding:14px;margin-bottom:20px;break-inside:avoid}
 .row{display:grid;gap:12px}
 figure{margin:0} img{width:100%;height:auto;border:1px solid #eee;border-radius:4px;background:#fff;display:block}
 figcaption{font-size:11px;color:#555;text-align:center;margin-top:4px;line-height:1.35}
 @media print{body{background:#fff;padding:0;max-width:none}.card{page-break-inside:avoid}a{color:inherit;text-decoration:none}}
</style>
<h1>Prompt cell comparison — all at 8 steps, all in one run</h1>
<div class="note">
 <b>1510</b> is the hallucination fixture: its background is a blown-out white room. Any curtain pleats,
 wall panelling or floorboards are <b>invented</b>. <b>1515</b> is the edge fixture.<br>
 <b>D</b> = your original prompt. <b>F1hi</b> = what is currently in <code>config.json</code> (guard removed, "fill the frame" added).
 <b>F2hi</b> = guard restored + stray-line negatives, no fill instruction. <b>F3hi</b> = eye fix only, no edge terms at all.
</div>
${body}`;

const htmlPath = join(dir, 'compare.html');
writeFileSync(htmlPath, html);
console.log('wrote', htmlPath);

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
const pdfPath = join(dir, flag('--out', 'compare.pdf'));
await page.pdf({ path: pdfPath, format: 'A3', landscape: true, printBackground: true, margin: { top: '7mm', bottom: '7mm', left: '5mm', right: '5mm' } });
await browser.close();
console.log('wrote', pdfPath);
