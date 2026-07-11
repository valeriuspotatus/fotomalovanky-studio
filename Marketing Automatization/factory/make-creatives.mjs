#!/usr/bin/env node
// make-creatives.mjs — generate standalone, on-brand ad graphics (no photo needed).
// Each output is a self-contained 1080×1350 SVG using the real Fotomalovánky palette
// (from Logo.svg): red #FF3D3D · blue #20A1FF · amber #FFB400 · yellow #FFC947 · green #24D586.
// Style = the logo's: thick black outline, rounded, playful, crayon-box colors, a coloring
// page caught mid-colour. Copy is the already-linted seasonal headline/body.
//
// Usage:  node factory/make-creatives.mjs [key ...]     (no args = all)
// Output: creatives/graphics/<key>.svg   + creatives/graphics/index.html (gallery)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
const OUT = resolve(ROOT, "creatives/graphics");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const W = 1080, H = 1350, INK = "#1A1410";
const C = { red:"#FF3D3D", blue:"#20A1FF", amber:"#FFB400", yellow:"#FFC947", green:"#24D586", brown:"#B0703A" };

// Embed the real logo as a data URI (pixel-accurate brand mark).
const LOGO_PATH = resolve(ROOT, "Extra files/Fotomalovanky/Fotomalovanky logo/Logo.png");
let LOGO_URI = "";
try { LOGO_URI = "data:image/png;base64," + readFileSync(LOGO_PATH).toString("base64"); }
catch { console.warn("! Logo.png not found — creatives will render without the wordmark."); }
const LOGO_AR = 944 / 469;

const esc = s => String(s).replace(/[&<>]/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[m]));

// ── drawing helpers ───────────────────────────────────────────────────────────
const stroke = (w = 7) => `fill="none" stroke="${INK}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;

function crayon(cx, cy, len, w, angle, color) {
  const half = len / 2, tip = w * 1.15;
  return `<g transform="translate(${cx} ${cy}) rotate(${angle})">
    <rect x="${-half}" y="${-w/2}" width="${len - tip}" height="${w}" rx="${w*0.34}" fill="${color}" stroke="${INK}" stroke-width="5"/>
    <path d="M ${half - tip} ${-w/2} L ${half} 0 L ${half - tip} ${w/2} Z" fill="${color}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
    <rect x="${-half + w*0.55}" y="${-w/2}" width="7" height="${w}" fill="${INK}" opacity="0.22"/>
  </g>`;
}
function star(cx, cy, r, fill) {
  let p = "";
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.45 : r, a = -Math.PI / 2 + i * Math.PI / 5;
    p += (i ? "L" : "M") + (cx + rr * Math.cos(a)).toFixed(1) + " " + (cy + rr * Math.sin(a)).toFixed(1) + " ";
  }
  return `<path d="${p}Z" fill="${fill}" stroke="${INK}" stroke-width="6" stroke-linejoin="round"/>`;
}
const confetti = (W, H) => {
  const top = [[70,150,C.red,10],[150,300,C.amber,7],[95,470,C.blue,8],[W-70,140,C.green,9],
    [W-120,320,C.red,7],[W-60,460,C.amber,8],[W/2,120,C.yellow,7]];
  const bot = [[80,H-170,C.blue,8],[150,H-100,C.amber,7],[W-80,H-180,C.red,9],[W-120,H-90,C.green,8]];
  return [...top, ...bot].map(([x,y,c,r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" stroke="${INK}" stroke-width="3"/>`).join("");
};

// three delivery formats — one layout table each; portrait keeps the plain <key>.svg name
const FORMATS = [
  { name:"portrait", suffix:"", w:1080, h:1350, label:"1080×1350 feed",
    logoW:380, logoY:54, eb:{y:248,h:42,w:400,fs:21},
    card:{x:230,y:306,w:620,h:520}, mscale:1.0,
    head:{base:902,shift:30, s2:74,l2:92, s3:62,l3:78}, bodyFs:30, bodyGap:64,
    cta:{w:476,h:92,fs:34,gap:74}, footer:{y:1298,dotW:44,dotH:18,gap:56,urlDy:52,urlFs:20}, codeFs:13, codeDy:14 },
  { name:"square", suffix:"-square", w:1080, h:1080, label:"1080×1080 square",
    logoW:300, logoY:42, eb:{y:196,h:40,w:376,fs:20},
    card:{x:290,y:248,w:500,h:378}, mscale:0.72,
    head:{base:716,shift:22, s2:58,l2:72, s3:48,l3:60}, bodyFs:26, bodyGap:52,
    cta:{w:420,h:78,fs:30,gap:56}, footer:{y:1034,dotW:38,dotH:16,gap:48,urlDy:44,urlFs:18}, codeFs:12, codeDy:12 },
  { name:"story", suffix:"-story", w:1080, h:1920, label:"1080×1920 story/reel",
    logoW:460, logoY:150, eb:{y:410,h:52,w:520,fs:27},
    card:{x:170,y:520,w:740,h:680}, mscale:1.3,
    head:{base:1400,shift:80, s2:92,l2:116, s3:76,l3:98}, bodyFs:30, bodyGap:96,
    cta:{w:560,h:108,fs:42,gap:96}, footer:{y:1828,dotW:56,dotH:22,gap:70,urlDy:64,urlFs:26}, codeFs:15, codeDy:16 }
];

// ── motifs (drawn centred on 0,0; a coloring page caught mid-colour) ───────────
const MOTIF = {
  tree() {
    return `
    <polygon points="0,-150 -140,150 140,150" fill="${C.green}" ${''} stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
    <polygon points="0,-100 -105,30 105,30" fill="${C.green}" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
    <polygon points="0,-190 -70,-70 70,-70" fill="#FFFFFF" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
    <rect x="-26" y="150" width="52" height="46" rx="6" fill="${C.brown}" stroke="${INK}" stroke-width="7"/>
    ${star(0,-198,34,C.amber)}
    <circle cx="-46" cy="92" r="15" fill="${C.red}" stroke="${INK}" stroke-width="5"/>
    <circle cx="52" cy="60" r="15" fill="${C.blue}" stroke="${INK}" stroke-width="5"/>
    <circle cx="0" cy="128" r="15" fill="${C.amber}" stroke="${INK}" stroke-width="5"/>
    ${crayon(150, -40, 150, 34, 58, C.green)}`;
  },
  boot() {
    return `
    <path d="M -70 -150 h 150 a 20 20 0 0 1 20 20 v 150 q 60 10 70 90 q 8 70 -70 74 h -190 q -60 -4 -60 -60 v -20 q 0 -34 40 -44 v -190 a 20 20 0 0 1 20 -20 z"
      fill="${C.red}" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
    <path d="M -90 -150 h 190 a 20 20 0 0 1 20 20 v 34 h -230 v -34 a 20 20 0 0 1 20 -20 z" fill="#FFFFFF" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
    ${star(70,150,30,C.amber)}
    ${crayon(-30, -200, 150, 32, -12, C.red)}`;
  },
  gift() {
    return `
    <rect x="-160" y="-40" width="320" height="200" rx="14" fill="${C.amber}" stroke="${INK}" stroke-width="7"/>
    <rect x="-180" y="-92" width="360" height="60" rx="12" fill="${C.yellow}" stroke="${INK}" stroke-width="7"/>
    <rect x="-30" y="-92" width="60" height="252" fill="${C.blue}" stroke="${INK}" stroke-width="7"/>
    <path d="M 0 -92 C -70 -170 -170 -150 -120 -100 C -80 -70 -20 -92 0 -92 Z" fill="${C.blue}" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
    <path d="M 0 -92 C 70 -170 170 -150 120 -100 C 80 -70 20 -92 0 -92 Z" fill="${C.blue}" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
    <circle cx="0" cy="-92" r="16" fill="${C.red}" stroke="${INK}" stroke-width="6"/>
    ${crayon(150, 150, 150, 32, -32, C.blue)}`;
  },
  leaf() {
    return `
    <path d="M 0 170 C -170 60 -120 -160 0 -190 C 120 -160 170 60 0 170 Z" fill="${C.amber}" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
    <path d="M 0 160 V -170" ${stroke(6)}/>
    <path d="M 0 -60 L -80 -110 M 0 -60 L 80 -110 M 0 30 L -95 -6 M 0 30 L 95 -6 M 0 110 L -80 82 M 0 110 L 80 82" ${stroke(5)}/>
    <path d="M 0 170 C -170 60 -120 -160 0 -190 C 0 -190 0 170 0 170 Z" fill="${C.green}" opacity="0.9" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
    <path d="M 0 160 V -170" ${stroke(6)}/>
    ${crayon(150, -30, 150, 32, 52, C.green)}`;
  },
  heart() {
    return `
    <path d="M 0 150 C -190 20 -150 -160 -20 -110 C -6 -104 0 -84 0 -66 C 0 -84 6 -104 20 -110 C 150 -160 190 20 0 150 Z"
      fill="${C.red}" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
    <path d="M 0 150 C -190 20 -150 -160 -20 -110 C -6 -104 0 -84 0 -66 V 150 Z" fill="#FFFFFF" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
    ${crayon(-140, 150, 190, 34, -26, C.red)}
    ${crayon(150, 130, 190, 34, 26, C.amber)}`;
  }
};

// ── config: one creative per holiday set (copy = the linted seasonal headlines) ─
const CREATIVES = [
  { key:"christmas", tag:"VÁNOCE 2026", bg:"#FFF6EA", accent:C.red, motif:"tree",
    headline:["Dárek, který nikdo","jiný mít nebude"],
    body:"Z vaší letní fotky uděláme osobní omalovánku do Vánoc.",
    cta:"Vytvořit fotomalovánky", code:"X1 · FM_CZ_GIFT_FAM_SPLIT" },
  { key:"mikulas", tag:"MIKULÁŠ · 5. 12.", bg:"#EAF3FF", accent:C.blue, motif:"boot",
    headline:["Malý dárek","od Mikuláše"],
    body:"Osobní omalovánka, na které se dítě pozná. Něco lepšího než uhlí.",
    cta:"Vytvořit fotomalovánky", code:"M1 · FM_CZ_GIFT_KIDS_REAL" },
  { key:"blackfriday", tag:"BLACK FRIDAY · 27.–30. 11.", bg:"#FFF3DC", accent:C.amber, motif:"gift",
    headline:["Celý dárek","v jedné krabici"],
    body:"K omalovánce z vaší fotky přibalíme i pastelky. Bez čekání na výsledek.",
    cta:"Vytvořit fotomalovánky", code:"BF1 · FM_CZ_GIFT_NONE_REAL" },
  { key:"backtoschool", tag:"ZPÁTKY DO ŠKOLY · 1. 9.", bg:"#EDF9EA", accent:C.green, motif:"leaf",
    headline:["Kus léta,","který zůstane"],
    body:"Než prázdninové fotky zapadnou v mobilu, uděláme z nich omalovánku.",
    cta:"Vytvořit fotomalovánky", code:"BTS1 · FM_CZ_EMO_KIDS_HYBRID" },
  { key:"together", tag:"SPOLEČNÝ ČAS", bg:"#FFEFE7", accent:C.red, motif:"heart",
    headline:["Odpoledne,","u kterého sedí","celá rodina"],
    body:"Omalovánka z vaší společné fotky. Malujete, a jste u toho spolu.",
    cta:"Vytvořit fotomalovánky", code:"E23 · FM_CZ_TOGETHER_FAM_REAL" }
];

const FONT = "'Baloo 2','Nunito','Trebuchet MS','Segoe UI',system-ui,sans-serif";

function build(cfg, F) {
  const W = F.w, H = F.h;
  const cardCX = W / 2, cardCY = F.card.y + F.card.h / 2;
  const n = cfg.headline.length;
  const hSize = n >= 3 ? F.head.s3 : F.head.s2, hLine = n >= 3 ? F.head.l3 : F.head.l2;
  const hTop = F.head.base - (n - 2) * F.head.shift;
  let head = "";
  cfg.headline.forEach((ln, i) =>
    head += `<text x="${W/2}" y="${hTop + i*hLine}" text-anchor="middle" font-size="${hSize}" font-weight="800" fill="${INK}">${esc(ln)}</text>`);
  const bodyY = hTop + (n - 1) * hLine + F.bodyGap;
  const ctaY = bodyY + F.cta.gap, ctaW = F.cta.w, ctaH = F.cta.h;
  const logoH = Math.round(F.logoW / LOGO_AR);
  const tapeW = Math.round(90 * F.mscale), tapeH = Math.round(34 * F.mscale);
  const dots = [C.red,C.amber,C.yellow,C.green,C.blue];
  const dotSpan = 4 * F.footer.gap + F.footer.dotW, dotStart = -dotSpan / 2;

  const logo = LOGO_URI
    ? `<image href="${LOGO_URI}" x="${(W-F.logoW)/2}" y="${F.logoY}" width="${F.logoW}" height="${logoH}"/>`
    : `<text x="${W/2}" y="${F.logoY + 120}" text-anchor="middle" font-size="60" font-weight="800" fill="${INK}">Fotomalovánky</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
  <rect width="${W}" height="${H}" fill="${cfg.bg}"/>
  ${confetti(W, H)}
  ${logo}
  <!-- eyebrow -->
  <g>
    <rect x="${W/2 - F.eb.w/2}" y="${F.eb.y}" width="${F.eb.w}" height="${F.eb.h}" rx="${F.eb.h/2}" fill="${cfg.accent}" stroke="${INK}" stroke-width="4"/>
    <text x="${W/2}" y="${F.eb.y + F.eb.h/2 + F.eb.fs*0.35}" text-anchor="middle" font-size="${F.eb.fs}" font-weight="800" letter-spacing="2" fill="#FFFFFF">${esc(cfg.tag)}</text>
  </g>
  <!-- coloring-page card (taped down, caught mid-colour) -->
  <g transform="rotate(-1.5 ${cardCX} ${cardCY})">
    <rect x="${F.card.x}" y="${F.card.y}" width="${F.card.w}" height="${F.card.h}" rx="26" fill="#FFFFFF" stroke="${INK}" stroke-width="8"/>
    <rect x="${cardCX - tapeW/2}" y="${F.card.y - tapeH/2}" width="${tapeW}" height="${tapeH}" rx="6" fill="${C.yellow}" opacity="0.85" stroke="${INK}" stroke-width="3" transform="rotate(-6 ${cardCX} ${F.card.y})"/>
    <g transform="translate(${cardCX} ${cardCY}) scale(${F.mscale})">${MOTIF[cfg.motif]()}</g>
  </g>
  ${head}
  <text x="${W/2}" y="${bodyY}" text-anchor="middle" font-size="${F.bodyFs}" font-weight="500" fill="#5F5347">${esc(cfg.body)}</text>
  <!-- CTA -->
  <g>
    <rect x="${(W-ctaW)/2}" y="${ctaY}" width="${ctaW}" height="${ctaH}" rx="${ctaH/2}" fill="${cfg.accent}" stroke="${INK}" stroke-width="6"/>
    <text x="${W/2}" y="${ctaY + ctaH/2 + F.cta.fs*0.35}" text-anchor="middle" font-size="${F.cta.fs}" font-weight="800" fill="#FFFFFF">${esc(cfg.cta)} →</text>
  </g>
  <!-- crayon-box footer -->
  <g transform="translate(${W/2} ${F.footer.y})">
    ${dots.map((c,i)=>`<rect x="${(dotStart + i*F.footer.gap).toFixed(0)}" y="${-F.footer.dotH/2}" width="${F.footer.dotW}" height="${F.footer.dotH}" rx="${F.footer.dotH/2}" fill="${c}" stroke="${INK}" stroke-width="3"/>`).join("")}
    <text x="0" y="${F.footer.urlDy}" text-anchor="middle" font-size="${F.footer.urlFs}" font-weight="700" fill="#8A7E70">fotomalovanky.cz</text>
  </g>
  <text x="${W-16}" y="${H-F.codeDy}" text-anchor="end" font-size="${F.codeFs}" font-family="monospace" fill="#B8AC9C">${esc(cfg.code)} · ${F.label}</text>
</svg>`;
}

// ── run ────────────────────────────────────────────────────────────────────────
const want = process.argv.slice(2);
const list = want.length ? CREATIVES.filter(c => want.includes(c.key)) : CREATIVES;
let count = 0;
for (const cfg of list) {
  for (const F of FORMATS) { writeFileSync(resolve(OUT, cfg.key + F.suffix + ".svg"), build(cfg, F)); count++; }
  console.log("✓ " + cfg.key + " → " + FORMATS.map(F => cfg.key + F.suffix + ".svg").join(", "));
}
// gallery index — grouped by holiday, all three formats side by side
const gallery = `<!doctype html><meta charset="utf-8"><title>Fotomalovánky — standalone creatives</title>
<style>body{margin:0;background:#EFE7DA;color:#241E18;font-family:${FONT};padding:28px}
h1{font-size:22px}h2{font-size:15px;margin:28px 0 10px}
.row{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start}
figure{margin:0;background:#fff;border-radius:14px;box-shadow:0 6px 24px -12px rgba(0,0,0,.4);overflow:hidden;width:232px}
img{display:block;width:100%;background:#fff}figcaption{padding:8px 12px;font-size:12px;color:#5F5347}</style>
<h1>Standalone holiday creatives — 3 formats each</h1>
${list.map(c => `<h2>${esc(c.tag)} — ${esc(c.headline.join(" "))}</h2><div class="row">${
  FORMATS.map(F => `<figure><img src="${c.key}${F.suffix}.svg" alt="${esc(c.key + " " + F.name)}"><figcaption>${F.label}</figcaption></figure>`).join("")
}</div>`).join("")}`;
writeFileSync(resolve(OUT, "index.html"), gallery);
console.log("\n✓ index.html — " + count + " SVGs (" + list.length + " holidays × " + FORMATS.length + " formats)");
