// Build an interactive review page for a U8 run: click REDO Y/N per order, get a live redo rate
// and a one-line summary to paste back. Verdicts persist in localStorage, so closing the tab or
// reloading does not lose the pass.
//
//   node tools/reviewSheet.mjs [--dir outbox/u8v3] [--baseline outbox/u8]
//
// Opens as a plain local file — no server needed. Writes <dir>/review.html.
// Thumbs are reused from the contact sheet if present, otherwise regenerated.

import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const dir = resolve(flag('--dir', 'outbox/u8v3'));
const baselineDir = resolve(flag('--baseline', 'outbox/u8'));

const results = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
const rows = Object.values(results).filter((r) => r.status === 'ok' || r.status === 'failed');
if (!rows.length) {
  console.error('No rows in', join(dir, 'results.json'));
  process.exit(1);
}

const thumbs = join(dir, 'thumbs');
mkdirSync(thumbs, { recursive: true });
async function thumb(src, name, width = 620) {
  const dest = join(thumbs, name);
  if (!existsSync(dest)) await sharp(src).resize({ width, withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(dest);
  return `thumbs/${name}`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct = (v) => (v * 100).toFixed(1) + '%';

let cards = '';
for (const r of rows) {
  if (r.status === 'failed') {
    cards += `<section class="card" data-order="${esc(r.order)}" data-failed="1">
      <h2>Order ${esc(r.order)} <span class="pill bad">FAILED</span></h2><pre>${esc(r.error ?? '')}</pre></section>`;
    continue;
  }
  const cols = [];
  cols.push(`<figure><img loading="lazy" src="${await thumb(r.originalPath, `${r.order}_orig.jpg`)}"><figcaption>original photo</figcaption></figure>`);
  const oldDir = join(baselineDir, r.order);
  const oldBw = existsSync(oldDir) ? readdirSync(oldDir).find((f) => f.endsWith('_bw.png')) : null;
  if (oldBw) cols.push(`<figure><img loading="lazy" src="${await thumb(join(oldDir, oldBw), `${r.order}_old.jpg`)}"><figcaption>OLD — 4 steps, old prompt</figcaption></figure>`);
  cols.push(`<figure><img loading="lazy" src="${await thumb(r.coloringPngPath, `${r.order}_new.jpg`)}"><figcaption><b>NEW — 8 steps, v3 prompt</b></figcaption></figure>`);

  cards += `<section class="card" data-order="${esc(r.order)}">
    <h2>Order ${esc(r.order)}<span class="meta">ink ${pct(r.coverage)} · ${r.secs}s · blank tiles ${r.blankTiles}</span></h2>
    <div class="row">${cols.join('')}</div>
    <div class="ask">
      <span>Faces &amp; eyes right? Edges drawn, nothing imagined? Better than OLD?</span>
      <span class="btns">
        <button class="y" data-v="Y">REDO</button>
        <button class="n" data-v="N">OK</button>
        <button class="clear" data-v="">clear</button>
      </span>
    </div>
  </section>`;
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>U8 review — v3 @ 8 steps</title>
<style>
 body{font:15px/1.55 system-ui,sans-serif;margin:0;background:#f6f6f7;color:#111}
 .wrap{max-width:1500px;margin:0 auto;padding:20px 26px 80px}
 h1{margin:6px 0 4px}
 .bar{position:sticky;top:0;z-index:5;background:#fff;border-bottom:1px solid #ddd;padding:12px 26px;
      display:flex;gap:22px;align-items:center;flex-wrap:wrap;box-shadow:0 1px 4px rgba(0,0,0,.06)}
 .bar b{font-size:19px}
 .rate{font-size:19px}
 .rate.good{color:#128a3a} .rate.bad{color:#c22}
 textarea{flex:1;min-width:340px;height:34px;font:13px/1.4 ui-monospace,monospace;padding:7px 9px;
      border:1px solid #ccc;border-radius:6px;resize:vertical;background:#fbfbfb}
 .copy{padding:8px 14px;border:1px solid #888;border-radius:6px;background:#fff;cursor:pointer}
 .card{background:#fff;border:1px solid #ddd;border-radius:9px;padding:16px;margin:20px 0}
 .card.redo{border-color:#d33;box-shadow:0 0 0 2px #fdd inset}
 .card.ok{border-color:#128a3a;box-shadow:0 0 0 2px #dff0e3 inset}
 h2{font-size:17px;margin:0 0 12px}
 .meta{font-size:12px;color:#666;font-weight:400;margin-left:10px}
 .row{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
 figure{margin:0} img{width:100%;height:auto;border:1px solid #eee;border-radius:4px;background:#fff;display:block;cursor:zoom-in}
 figcaption{font-size:12px;color:#666;text-align:center;margin-top:5px}
 .ask{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-top:13px;
      padding-top:10px;border-top:1px dashed #ddd;font-size:14px}
 .btns{display:flex;gap:8px}
 button{padding:7px 16px;border-radius:6px;border:1px solid #bbb;background:#fff;cursor:pointer;font:inherit}
 button.y{border-color:#d33;color:#d33} button.n{border-color:#128a3a;color:#128a3a}
 button.clear{color:#888;font-size:12px;padding:7px 10px}
 button[aria-pressed="true"].y{background:#d33;color:#fff}
 button[aria-pressed="true"].n{background:#128a3a;color:#fff}
 .pill.bad{color:#d33;border:1px solid #d33;border-radius:4px;padding:1px 6px;font-size:13px}
 pre{font-size:12px;color:#a00;white-space:pre-wrap}
 dialog{border:none;border-radius:8px;padding:0;max-width:96vw;max-height:96vh}
 dialog img{max-width:96vw;max-height:96vh;cursor:zoom-out}
 dialog::backdrop{background:rgba(0,0,0,.8)}
</style></head><body>
<div class="bar">
  <span>reviewed <b id="done">0</b>/<b id="total">0</b></span>
  <span class="rate" id="rate">redo —</span>
  <textarea id="out" readonly spellcheck="false"></textarea>
  <button class="copy" id="copy">Copy summary</button>
</div>
<div class="wrap">
  <h1>U8 review — v3 prompt @ 8 steps</h1>
  <p>Click <b>REDO</b> if you'd redo the NEW render, <b>OK</b> if you'd ship it. Click any image to enlarge.
     Your answers are saved in this browser, so you can stop and come back. The old baseline was <b>3/20 = 15%</b>.</p>
  ${cards}
</div>
<dialog id="lb"><img id="lbimg" alt=""></dialog>
<script>
const KEY = 'u8review:' + location.pathname;
const state = JSON.parse(localStorage.getItem(KEY) || '{}');
const cards = [...document.querySelectorAll('.card:not([data-failed])')];
document.getElementById('total').textContent = cards.length;

function paint() {
  let redo = [], ok = 0;
  for (const c of cards) {
    const o = c.dataset.order, v = state[o];
    c.classList.toggle('redo', v === 'Y');
    c.classList.toggle('ok', v === 'N');
    for (const b of c.querySelectorAll('button[data-v]')) b.setAttribute('aria-pressed', String(b.dataset.v === v && v !== ''));
    if (v === 'Y') redo.push(o); else if (v === 'N') ok++;
  }
  const done = redo.length + ok;
  document.getElementById('done').textContent = done;
  const rate = document.getElementById('rate');
  const out = document.getElementById('out');
  if (!done) { rate.textContent = 'redo —'; rate.className = 'rate'; out.value = ''; return; }
  const p = (redo.length / done * 100).toFixed(0);
  rate.textContent = 'redo ' + redo.length + '/' + done + ' = ' + p + '%';
  rate.className = 'rate ' + (redo.length / done <= 0.15 ? 'good' : 'bad');
  out.value = 'REDO ' + redo.length + '/' + done + ' (' + p + '%)' + (redo.length ? ' — orders: ' + redo.join(', ') : ' — none') +
    (done < cards.length ? '  [' + (cards.length - done) + ' not yet reviewed]' : '');
}

for (const c of cards) {
  for (const b of c.querySelectorAll('button[data-v]')) {
    b.addEventListener('click', () => {
      const o = c.dataset.order;
      if (b.dataset.v === '') delete state[o]; else state[o] = b.dataset.v;
      localStorage.setItem(KEY, JSON.stringify(state));
      paint();
    });
  }
}
document.getElementById('copy').addEventListener('click', async () => {
  const out = document.getElementById('out');
  if (!out.value) return;
  try { await navigator.clipboard.writeText(out.value); } catch { out.select(); document.execCommand('copy'); }
  const b = document.getElementById('copy');
  b.textContent = 'Copied!'; setTimeout(() => (b.textContent = 'Copy summary'), 1200);
});
const lb = document.getElementById('lb'), lbimg = document.getElementById('lbimg');
document.addEventListener('click', (e) => {
  if (e.target.tagName === 'IMG' && e.target.closest('figure')) { lbimg.src = e.target.src; lb.showModal(); }
  else if (e.target === lbimg || e.target === lb) lb.close();
});
paint();
</script></body></html>`;

const out = join(dir, 'review.html');
writeFileSync(out, html);
console.log('wrote', out);
