// U8 value gate — re-runnable. Generates one photo per order through the CURRENT config and
// builds a contact sheet where the operator marks REDO Y/N. That count is the redo rate.
//
//   node tools/u8Sample.mjs [--in outbox/u8] [--out outbox/u8v3] [--baseline outbox/u8] [--limit N]
//
// --in       source of the input photos (one "<base>.jpg" per order directory)
// --baseline a previous run's outputs, shown beside the new ones for direct comparison
//
// Everything lands under outbox/ (gitignored: customer photos). The redo rate is the deliverable;
// QC only catches degenerate output and has never predicted an operator redo — see the U8 spike.

import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { loadConfig, redactForLog } from '../src/config.js';
import { ApiGeneratorDriver } from '../src/generator/apiDriver.js';
import { assessColoringPixels, assessColoringSvg } from '../src/qc.js';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const inDir = resolve(flag('--in', 'outbox/u8'));
const outDir = resolve(flag('--out', 'outbox/u8v3'));
const baselineDir = resolve(flag('--baseline', 'outbox/u8'));
const limit = Number(flag('--limit', '0')) || Infinity;

const GRID = 6;
const BLANK_TILE = 0.005;

async function inkMetrics(pngPath) {
  const { data, info } = await sharp(pngPath).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const global = assessColoringPixels(data);
  let blank = 0;
  let blankBorder = 0;
  for (let ty = 0; ty < GRID; ty++) {
    for (let tx = 0; tx < GRID; tx++) {
      const x0 = Math.floor((tx * width) / GRID), x1 = Math.floor(((tx + 1) * width) / GRID);
      const y0 = Math.floor((ty * height) / GRID), y1 = Math.floor(((ty + 1) * height) / GRID);
      let ink = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++, n++) if (data[row + x] < 128) ink++;
      }
      if (n && ink / n < BLANK_TILE) {
        blank++;
        if (tx === 0 || ty === 0 || tx === GRID - 1 || ty === GRID - 1) blankBorder++;
      }
    }
  }
  return { coverage: global.coverage ?? 0, qcVerdict: global.verdict, qcReason: global.reason, blankTiles: blank, blankBorderTiles: blankBorder };
}

// ---- discover one input photo per order ------------------------------------

const orders = readdirSync(inDir)
  .filter((d) => /^\d+$/.test(d) && statSync(join(inDir, d)).isDirectory())
  .sort()
  .slice(0, limit);

if (!orders.length) {
  console.error(`No order directories found under ${inDir}`);
  process.exit(2);
}

const config = loadConfig();
const g = config.generator;
console.log('Generator:', redactForLog(config).generator.baseUrl);
console.log(`Config: variant ${g.variant}, steps ${g.diffusionSteps}, positive ${g.positivePrompt.length}ch, negative ${g.negativePrompt.length}ch`);
console.log(`Sample: ${orders.length} orders, one photo each -> ${outDir}\n`);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'prompts.json'), JSON.stringify({ variant: g.variant, diffusionSteps: g.diffusionSteps, positivePrompt: g.positivePrompt, negativePrompt: g.negativePrompt }, null, 2));

const driver = new ApiGeneratorDriver(config);
const results = {};
let n = 0;

for (const order of orders) {
  const src = readdirSync(join(inDir, order)).find((f) => /\.jpe?g$/i.test(f) && !/_bw\./i.test(f));
  const tag = `[${++n}/${orders.length}] order ${order}`;
  if (!src) {
    console.log(`${tag} — no input photo, skipped`);
    results[order] = { order, status: 'skipped', reason: 'no input photo' };
    continue;
  }
  const photoPath = join(inDir, order, src);
  const workDir = join(outDir, order);
  console.log(`=== ${tag} — ${src}`);
  const t0 = Date.now();
  try {
    const out = await driver.generate(photoPath, {
      ...g,
      workDir,
      onProgress: ({ step, message }) => process.stdout.write(`  [${step}] ${message}\n`),
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    const ink = await inkMetrics(out.coloringPngPath);
    const svg = assessColoringSvg(readFileSync(out.coloringSvgPath, 'utf8'));
    results[order] = {
      order,
      status: 'ok',
      photoName: src,
      secs,
      variantKey: out.variantKey,
      ...ink,
      qcSvg: svg.verdict,
      qcSvgReason: svg.reason,
      originalPath: out.originalPath,
      coloringPngPath: out.coloringPngPath,
      coloringSvgPath: out.coloringSvgPath,
    };
    console.log(`  -> ok ${secs}s ink ${(ink.coverage * 100).toFixed(2)}% blankTiles ${ink.blankTiles} qc ${ink.qcVerdict}/${svg.verdict}`);
  } catch (err) {
    const secs = Math.round((Date.now() - t0) / 1000);
    // One photo failing must not abort the batch (plan R3/U3). Record and continue.
    console.error(`  -> FAILED after ${secs}s at "${err.step ?? '?'}": ${err.message}`);
    results[order] = { order, status: 'failed', photoName: src, secs, error: err.message, step: err.step ?? null };
  }
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
}

// ---- contact sheet ---------------------------------------------------------

const rows = Object.values(results);
const ok = rows.filter((r) => r.status === 'ok');
const failed = rows.filter((r) => r.status === 'failed');
const flagged = ok.filter((r) => r.qcVerdict !== 'ok' || r.qcSvg !== 'ok');
const covs = ok.map((r) => r.coverage).sort((a, b) => a - b);
const median = covs.length ? covs[Math.floor(covs.length / 2)] : 0;

const thumbs = join(outDir, 'thumbs');
mkdirSync(thumbs, { recursive: true });
const thumb = async (src, name, width = 620) => {
  await sharp(src).resize({ width, withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(join(thumbs, name));
  return `thumbs/${name}`;
};
const pct = (v) => (v * 100).toFixed(1) + '%';
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

let cards = '';
for (const r of rows) {
  if (r.status === 'skipped') continue;
  if (r.status === 'failed') {
    cards += `<section class="card bad"><h2>Order ${esc(r.order)} <span class="flag">FAILED</span></h2><pre>${esc(r.error)}</pre></section>`;
    continue;
  }
  const cols = [];
  cols.push(`<figure><img src="${await thumb(r.originalPath, `${r.order}_orig.jpg`)}"><figcaption>original photo</figcaption></figure>`);
  const oldBw = existsSync(join(baselineDir, r.order))
    ? readdirSync(join(baselineDir, r.order)).find((f) => f.endsWith('_bw.png'))
    : null;
  if (oldBw) cols.push(`<figure><img src="${await thumb(join(baselineDir, r.order, oldBw), `${r.order}_old.jpg`)}"><figcaption>OLD — 4 steps, old prompt</figcaption></figure>`);
  cols.push(`<figure><img src="${await thumb(r.coloringPngPath, `${r.order}_new.jpg`)}"><figcaption><b>NEW — 8 steps, v3 prompt</b></figcaption></figure>`);
  const qcBad = r.qcVerdict !== 'ok' || r.qcSvg !== 'ok';
  cards += `<section class="card${qcBad ? ' bad' : ''}">
    <h2>Order ${esc(r.order)} ${qcBad ? '<span class="flag">QC FLAG</span>' : ''}
      <span class="meta">ink ${pct(r.coverage)} · ${r.secs}s · ${esc(r.variantKey ?? '')} · blank tiles ${r.blankTiles}</span></h2>
    <div class="row">${cols.join('')}</div>
    <p class="ask">Compare NEW against OLD. Faces/eyes right? Edges drawn, nothing imagined? &nbsp;&nbsp;<b>REDO?</b> &nbsp; Y &nbsp;/&nbsp; N</p>
  </section>`;
}

const html = `<!doctype html><meta charset="utf-8"><title>U8 re-run — v3 prompt @ 8 steps</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;padding:30px;max-width:1500px;background:#fafafa;color:#111}
 h1{margin:0 0 12px} h2{font-size:17px;margin:0 0 12px}
 .summary{background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px 20px}
 .warn{background:#fff8e1;border:1px solid #f0c36d;border-radius:8px;padding:12px 16px;margin:16px 0 26px}
 .card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;margin-bottom:22px;break-inside:avoid}
 .card.bad{border-color:#d33;box-shadow:0 0 0 2px #fdd inset}
 .flag{color:#d33;font-size:13px;border:1px solid #d33;border-radius:4px;padding:1px 6px;vertical-align:middle}
 .row{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
 figure{margin:0} img{width:100%;height:auto;border:1px solid #eee;border-radius:4px;background:#fff;display:block}
 figcaption{font-size:12px;color:#666;text-align:center;margin-top:5px}
 .meta{font-size:12px;color:#666;font-weight:400;margin-left:8px}
 .ask{font-size:14px;margin:13px 0 0;padding-top:9px;border-top:1px dashed #ddd}
 pre{font-size:12px;color:#a00;white-space:pre-wrap}
 @media print{body{background:#fff;padding:0;max-width:none}.card{page-break-inside:avoid}}
</style>
<h1>U8 re-run — v3 prompt @ 8 steps</h1>
<div class="summary">
 <b>${ok.length}</b> generated · <b>${failed.length}</b> failed · <b>${flagged.length}</b> QC-flagged<br>
 ink coverage ${covs.length ? pct(covs[0]) + ' – ' + pct(covs.at(-1)) + ' (median ' + pct(median) + ')' : 'n/a'}<br>
 variant <code>${esc(g.variant)}</code>, <b>${g.diffusionSteps} diffusion steps</b>, one photo per order, single variant, no retries.
</div>
<div class="warn">
 <b>QC is a lower bound.</b> It only catches degenerate output. It cannot see invented eyes, hallucinated
 edges, or lost likeness — in the first U8 run it flagged <b>0</b> of the 3 photos you redid.
 Mark <b>REDO?</b> on each card; that count is the real manual-touch rate for this configuration.
</div>
${cards}`;

const htmlPath = join(outDir, 'contact.html');
writeFileSync(htmlPath, html);
console.log(`\nwrote ${htmlPath}`);

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
const pdfPath = join(outDir, 'contact.pdf');
await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '9mm', bottom: '9mm', left: '7mm', right: '7mm' } });
await browser.close();
console.log(`wrote ${pdfPath}`);
console.log(`\n${ok.length}/${rows.length} ok, ${failed.length} failed, ${flagged.length} QC-flagged.`);
