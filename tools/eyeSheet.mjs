// Render an eye-treatment comparison as a printable sheet: for each fixture photo, zoom the
// faces that carry the defect and stack the cells side by side.
//
//   node tools/eyeSheet.mjs --dir outbox/ab5 [--out eyes.pdf]
//
// Every cell must come from the SAME run — the generator is only reproducible within a run
// (see docs/spikes/2026-07-09-u8-value-gate.md), so a control from a previous run is not a control.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const dir = resolve(flag('--dir', 'outbox/ab5'));

// Fixture photos and the regions that actually carry the defect. Boxes are fractions of w/h.
const FIXTURES = [
  {
    prefix: '1515_img0001',
    title: 'Order 1515 — man’s eyes are CLOSED in the photo, girl’s eyes are CLOSED',
    orig: 'outbox/u8/1515/1515_img0001_-_julka__agnes__honzik.jpg',
    regions: [
      { name: 'GIRL (left) — eyes closed in photo', box: [0.225, 0.325, 0.345, 0.415] },
      { name: 'MAN — eyes closed, looking down in photo', box: [0.47, 0.2, 0.62, 0.31] },
    ],
  },
  {
    prefix: '1523_img0002',
    title: 'Order 1523 img2 — woman in opaque SUNGLASSES, man’s eyes OPEN',
    orig: 'Fotomalovanky.cz - Objednávka 1522 Original downloaded imput/1523_img0002_-_hofbauerovi_18.7.2026.jpeg',
    regions: [
      { name: 'WOMAN — sunglasses (lenses must stay EMPTY)', box: [0.26, 0.55, 0.6, 0.74] },
      { name: 'MAN — eyes open (pupils MUST survive)', box: [0.57, 0.49, 0.85, 0.63] },
    ],
  },
];

const CELL = /__([A-Za-z0-9]+)-r(\d)$/;
const labels = {};
for (const r of JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'))) labels[r.config] ??= r.label;

const thumbs = join(dir, 'eyethumbs');
mkdirSync(thumbs, { recursive: true });

function bwFor(prefix, cell) {
  const d = readdirSync(dir).find((x) => x.startsWith(prefix) && x.endsWith(`__${cell}`));
  if (!d) return null;
  const f = readdirSync(join(dir, d)).find((x) => x.endsWith('_bw.png'));
  return f ? join(dir, d, f) : null;
}

async function crop(src, box, name) {
  const m = await sharp(src).metadata();
  const [x0, y0, x1, y1] = box;
  const dest = join(thumbs, name);
  await sharp(src)
    .extract({
      left: Math.round(x0 * m.width),
      top: Math.round(y0 * m.height),
      width: Math.round((x1 - x0) * m.width),
      height: Math.round((y1 - y0) * m.height),
    })
    .resize({ width: 620 })
    .jpeg({ quality: 88 })
    .toFile(dest);
  return `eyethumbs/${name}`;
}

const cells = [...new Set(readdirSync(dir).filter((d) => CELL.test(d)).map((d) => d.match(CELL)[1]))].sort();
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

let body = '';
for (const fx of FIXTURES) {
  if (!cells.some((c) => bwFor(fx.prefix, `${c}-r1`))) continue;
  body += `<h2>${esc(fx.title)}</h2>`;
  for (const region of fx.regions) {
    const cols = [];
    const origAbs = resolve(fx.orig);
    if (existsSync(origAbs)) {
      const t = await crop(origAbs, region.box, `${fx.prefix}_${region.name.slice(0, 6)}_orig.jpg`.replace(/\s/g, ''));
      cols.push(`<figure><img src="${t}"><figcaption><b>ORIGINAL PHOTO</b></figcaption></figure>`);
    }
    for (const c of cells) {
      const src = bwFor(fx.prefix, `${c}-r1`);
      if (!src) continue;
      const t = await crop(src, region.box, `${fx.prefix}_${region.name.slice(0, 6)}_${c}.jpg`.replace(/\s/g, ''));
      const lab = labels[c] ?? c;
      const isCtl = /^edge prompt/.test(lab);
      cols.push(
        `<figure class="${isCtl ? 'ctl' : ''}"><img src="${t}"><figcaption>${esc(lab)}${isCtl ? ' <b>(baseline)</b>' : ''}</figcaption></figure>`,
      );
    }
    body += `<section class="card"><h3>${esc(region.name)}</h3><div class="row">${cols.join('')}</div></section>`;
  }
}

const html = `<!doctype html><meta charset="utf-8"><title>Eye treatments @ 8 steps</title>
<style>
 body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;padding:26px;max-width:1600px;background:#fafafa;color:#111}
 h1{margin:0 0 8px} h2{margin:26px 0 10px;font-size:18px;border-bottom:2px solid #ddd;padding-bottom:5px}
 h3{margin:0 0 10px;font-size:14px;color:#444}
 .note{background:#fff8e1;border:1px solid #f0c36d;border-radius:8px;padding:11px 15px;margin-bottom:18px}
 .card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:14px;margin-bottom:18px;break-inside:avoid}
 .row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
 figure{margin:0} figure.ctl img{border-color:#888;box-shadow:0 0 0 2px #eee inset}
 img{width:100%;height:auto;border:1px solid #eee;border-radius:4px;background:#fff;display:block}
 figcaption{font-size:11.5px;color:#555;text-align:center;margin-top:4px}
 @media print{body{background:#fff;padding:0;max-width:none}.card{page-break-inside:avoid}}
</style>
<h1>Eye treatments — all at 8 steps, all with your preferred edge prompt</h1>
<div class="note">
 Every image below was generated in <b>one run</b>. The generator only reproduces exactly within a
 single run, so a baseline from an earlier run would not be a valid comparison.
 The <b>baseline</b> column is your chosen config (edge prompt @ 8 steps) with the eye instruction
 left as it is today.
 <b>v1</b> deletes the eye demand from the positive prompt <i>and</i> <code>missing pupils, blank eyes</code>
 from the negative. <b>v3</b> deletes only the positive demand and <b>keeps</b> the negative pupil guard.
</div>
${body}`;

const htmlPath = join(dir, 'eyes.html');
writeFileSync(htmlPath, html);
console.log('wrote', htmlPath);

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
const pdfPath = join(dir, flag('--out', 'eyes.pdf'));
await page.pdf({ path: pdfPath, format: 'A4', landscape: true, printBackground: true, margin: { top: '8mm', bottom: '8mm', left: '6mm', right: '6mm' } });
await browser.close();
console.log('wrote', pdfPath);
