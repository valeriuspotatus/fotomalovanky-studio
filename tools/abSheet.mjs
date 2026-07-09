// Render the prompt A/B results into an eyeball-ready contact sheet (HTML + PDF).
//
//   node tools/abSheet.mjs [--out outbox/ab1] [--baseline outbox/u8]
//
// Groups every generation by config so the same photo's control and revised outputs sit
// side by side. Numbers alone cannot settle this — blank-tile counts flag unfinished
// edges, but only a human sees stray lines and hallucinated eyes.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const outDir = resolve(flag('--out', 'outbox/ab1'));
const baselineDir = resolve(flag('--baseline', 'outbox/u8'));

const results = JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8'));
const ok = results.filter((r) => r.status === 'ok');
if (ok.length === 0) {
  console.error('No successful generations in results.json — nothing to render.');
  process.exit(1);
}

const thumbs = join(outDir, 'thumbs');
mkdirSync(thumbs, { recursive: true });

async function thumb(src, name, width = 900) {
  const dest = join(thumbs, name);
  await sharp(src).resize({ width, withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(dest);
  return `thumbs/${name}`;
}

const pct = (v) => (v * 100).toFixed(2) + '%';
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// Order configs so the control leads and each revision follows.
const ORDER = ['A', 'D', 'B', 'C'];
const byConfig = new Map();
for (const r of ok) {
  if (!byConfig.has(r.config)) byConfig.set(r.config, []);
  byConfig.get(r.config).push(r);
}

// Per-config aggregate: the quantitative half of the verdict.
const agg = ORDER.filter((c) => byConfig.has(c)).map((c) => {
  const rows = byConfig.get(c);
  const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  return {
    config: c,
    label: rows[0].label,
    n: rows.length,
    coverage: mean((r) => r.coverage),
    blankTiles: mean((r) => r.blankTiles),
    blankBorderTiles: mean((r) => r.blankBorderTiles),
    blankCornerTiles: mean((r) => r.blankCornerTiles),
    svgPaths: mean((r) => r.svgPaths),
    secs: mean((r) => r.secs),
  };
});

const photoNames = [...new Set(ok.map((r) => r.photo))];
const parts = [];

for (const photo of photoNames) {
  // Reference: the original photo + the baseline U8 output, if we can find them.
  const orderId = photo.split('_')[0];
  const baseOrder = join(baselineDir, orderId);
  let refHtml = '';
  if (existsSync(baseOrder)) {
    const origSrc = join(baseOrder, `${photo}.jpg`);
    const bwSrc = join(baseOrder, `${photo}_bw.png`);
    const cells = [];
    if (existsSync(origSrc)) cells.push(`<figure><img src="${await thumb(origSrc, `${photo}__orig.jpg`)}"><figcaption>original photo</figcaption></figure>`);
    if (existsSync(bwSrc)) cells.push(`<figure><img src="${await thumb(bwSrc, `${photo}__baseline.jpg`)}"><figcaption>baseline (U8 run, control prompt)</figcaption></figure>`);
    if (cells.length) refHtml = `<section class="card"><h2>Reference — order ${esc(orderId)}</h2><div class="pair">${cells.join('')}</div></section>`;
  }
  parts.push(refHtml);

  for (const c of ORDER) {
    const rows = (byConfig.get(c) ?? []).filter((r) => r.photo === photo).sort((a, b) => a.rep - b.rep);
    if (!rows.length) continue;
    const cells = [];
    for (const r of rows) {
      const src = await thumb(r.coloringPngPath, `${photo}__${r.config}-r${r.rep}.jpg`);
      const warn = r.blankBorderTiles > 0 ? ' warnpill' : '';
      cells.push(
        `<figure><a href="${esc(r.coloringPngPath)}" target="_blank"><img src="${src}"></a>
         <figcaption>rep ${r.rep} &middot; ${r.secs}s &middot; ink ${pct(r.coverage)}
         &middot; <span class="pill${warn}">blank border tiles ${r.blankBorderTiles}</span>
         &middot; svg paths ${r.svgPaths}</figcaption></figure>`,
      );
    }
    const isControl = c === 'A';
    parts.push(
      `<section class="card${isControl ? ' control' : ''}">
         <h2>${esc(c)} — ${esc(rows[0].label)} ${isControl ? '<span class="tag">CONTROL</span>' : ''}</h2>
         <div class="pair">${cells.join('')}</div>
         <p class="ask">Edges drawn to the frame? Stray lines? Faces/likeness kept? &nbsp;&nbsp; <b>BETTER THAN CONTROL?</b> &nbsp; Y / N</p>
       </section>`,
    );
  }
}

const table = `<table>
  <tr><th>config</th><th>prompt / steps</th><th>n</th><th>ink</th><th>blank tiles</th><th>blank border</th><th>blank corner</th><th>svg paths</th><th>secs</th></tr>
  ${agg
    .map(
      (a) =>
        `<tr class="${a.config === 'A' ? 'ctl' : ''}"><td><b>${a.config}</b></td><td>${esc(a.label)}</td><td>${a.n}</td><td>${pct(a.coverage)}</td><td>${a.blankTiles.toFixed(1)}</td><td>${a.blankBorderTiles.toFixed(1)}</td><td>${a.blankCornerTiles.toFixed(1)}</td><td>${Math.round(a.svgPaths)}</td><td>${Math.round(a.secs)}</td></tr>`,
    )
    .join('')}
</table>`;

const html = `<!doctype html><meta charset="utf-8"><title>Prompt A/B — edge failure</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;padding:32px;max-width:1500px;background:#fafafa;color:#111}
 h1{margin:0 0 12px} h2{font-size:17px;margin:0 0 12px}
 .summary{background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px 20px;margin-bottom:20px}
 .warn{background:#fff8e1;border:1px solid #f0c36d;border-radius:8px;padding:12px 16px;margin:16px 0 28px}
 .card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:18px;margin-bottom:24px;break-inside:avoid}
 .card.control{border-color:#888;background:#f4f4f4}
 .tag{font-size:11px;border:1px solid #888;border-radius:4px;padding:1px 6px;vertical-align:middle;color:#555}
 .pair{display:grid;grid-template-columns:1fr 1fr;gap:18px}
 figure{margin:0} img{width:100%;height:auto;border:1px solid #eee;border-radius:4px;background:#fff;display:block}
 figcaption{font-size:12px;color:#666;text-align:center;margin-top:5px}
 .pill{border:1px solid #ccc;border-radius:4px;padding:0 5px}
 .pill.warnpill{border-color:#d33;color:#d33;font-weight:600}
 .ask{font-size:14px;margin:14px 0 0;padding-top:10px;border-top:1px dashed #ddd}
 table{border-collapse:collapse;margin-top:10px;font-size:13px}
 td,th{border:1px solid #ddd;padding:5px 10px;text-align:right} th:nth-child(2),td:nth-child(2){text-align:left}
 tr.ctl{background:#f0f0f0}
 @media print{body{background:#fff;padding:0;max-width:none}.card{page-break-inside:avoid}a{text-decoration:none;color:inherit}}
</style>
<h1>Prompt A/B — the "missing / random edges" failure</h1>
<div class="summary">
  2&times;2 factorial: <b>prompt</b> (control vs edge-revised) &times; <b>diffusion steps</b>.
  The generator exposes <b>no seed</b>, so each cell was generated ${ok[0] ? [...new Set(ok.map((r) => r.rep))].length : 0}&times; — differences
  smaller than the spread between reps are noise, not signal.
  ${table}
</div>
<div class="warn">
  <b>Numbers are a hint, not the verdict.</b> "Blank border tiles" catches unfinished edges, but a
  legitimately empty sky also reads as blank. Stray lines and likeness are invisible to it.
  Judge each config against the <b>CONTROL</b> card by eye.
</div>
${parts.join('\n')}
`;

const htmlPath = join(outDir, 'ab.html');
writeFileSync(htmlPath, html);
console.log('wrote', htmlPath);
console.table(agg.map((a) => ({ config: a.config, label: a.label, ink: pct(a.coverage), blankBorder: a.blankBorderTiles.toFixed(1), svgPaths: Math.round(a.svgPaths), secs: Math.round(a.secs) })));

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
const pdfPath = join(outDir, 'ab.pdf');
await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' } });
await browser.close();
console.log('wrote', pdfPath);
