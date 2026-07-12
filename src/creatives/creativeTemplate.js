// The Kreativy template engine (pure). Turns a set of fields — headline, a highlighted word, an
// optional seasonal badge, a "before" photo and its "after" line-art — into a self-contained HTML
// document that reproduces the Fotomalovánky ad look: a pastel rainbow wash, crayon doodles, the
// multicolour wordmark, the photo-to-coloring-page reveal, and a bold Czech headline. renderCreative.js
// screenshots this HTML to PNG via the same headless Chromium the PDF builder already uses.
//
// Pure: no filesystem, no network. Images arrive as ready-to-use `src` strings (data: URIs or file
// URLs) so the caller owns IO and this stays unit-testable. Fonts follow the app's --font-display
// stack (Fredoka is not self-hosted yet, so Chromium falls back to its rounded system face).

/** The three ad canvases. Square is the default; story is tall (9:16); wide is a landscape banner. */
export const FORMATS = Object.freeze({
  square: { w: 1080, h: 1080, label: 'Feed 1:1' },
  story: { w: 1080, h: 1920, label: 'Story 9:16' },
  wide: { w: 1200, h: 630, label: 'Wide 1.91:1' },
});

/** Pastel background washes lifted from the reference ads. `accent` tints the highlighted word. */
export const PALETTES = Object.freeze({
  rainbow: { bg: 'linear-gradient(120deg,#DDF3E3 0%,#FBF2D6 32%,#FDE4D4 64%,#FBD9E7 100%)', accent: '#22A06B' },
  sunset: { bg: 'linear-gradient(120deg,#FCDDEA 0%,#FDE6D6 50%,#FBEFD4 100%)', accent: '#F1543F' },
  sky: { bg: 'linear-gradient(120deg,#E4F0FB 0%,#EAF6EE 52%,#FBE8F0 100%)', accent: '#3B82F6' },
});

/** Ready-made campaigns: the copy + badge + palette for a season. Headline is split so the last
 *  word (`highlight`) gets the marker treatment, mirroring the ads ("…se dá **vybarvit**"). */
export const CAMPAIGNS = Object.freeze({
  obecny: { title: 'Obecná', headline: 'Vzpomínka, která se dá', highlight: 'vybarvit', badge: null, palette: 'rainbow', imagePrompt: 'Radostná rodina doma, jak si společně prohlíží fotografii, přirozené měkké světlo, reklamní fotografie.' },
  dendeti: { title: 'Den dětí', headline: 'Vzpomínky, které si můžete', highlight: 'vybarvit', badge: 'Originální dárek ke Dni dětí', palette: 'rainbow', imagePrompt: 'Šťastné dítě venku v létě, jak se směje, slunečný den, reklamní fotografie.' },
  vanoce: { title: 'Vánoce', headline: 'Dárek, který se dá', highlight: 'vybarvit', badge: 'Vánoční dárek na míru', palette: 'sunset', imagePrompt: 'Rodina u vánočního stromku, teplé světlo, útulná sváteční atmosféra, reklamní fotografie.' },
  skola: { title: 'Zpátky do školy', headline: 'Kus léta, který', highlight: 'zůstane', badge: 'Zpátky do školy', palette: 'sky', imagePrompt: 'Usměvavé dítě s aktovkou první školní den, ranní světlo, reklamní fotografie.' },
  mikulas: { title: 'Mikuláš', headline: 'Malý dárek od', highlight: 'Mikuláše', badge: 'Mikuláš 5. 12.', palette: 'sunset', imagePrompt: 'Dítě drží mikulášský dárek, prosincový večer, teplé světlo, reklamní fotografie.' },
});

const WORDMARK_HUES = ['#F1543F', '#F5A623', '#22A06B', '#3B82F6']; // coral, amber, green, blue

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** "FOTOMALOVÁNKY" with each letter cycling the brand hues. */
function wordmark() {
  return [...'FOTOMALOVÁNKY'].map((ch, i) => `<span style="color:${WORDMARK_HUES[i % WORDMARK_HUES.length]}">${esc(ch)}</span>`).join('');
}

/** A small hand-drawn "photo + pencil" logo mark. */
function logoMark() {
  return `<svg class="mark" viewBox="0 0 82 74" fill="none" stroke="#2A2622" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round">
    <rect x="7" y="10" width="50" height="52" rx="4" transform="rotate(-6 32 36)" fill="#fff"/>
    <circle cx="31" cy="31" r="6.5" fill="none"/><path d="M20 52a12 12 0 0 1 23 0" transform="rotate(-6 32 36)"/>
    <path d="M59 13l15 12-9 12-15-12z" fill="#F5A623"/><path d="M50 25l5 4"/>
  </svg>`;
}

/** A cartoon crayon, tip up, in `color`. */
function crayon(color) {
  return `<svg viewBox="0 0 64 210" fill="none" stroke="#2A2622" stroke-width="3" stroke-linejoin="round">
    <path d="M14 66 L32 12 L50 66 Z" fill="#FBE9D6"/>
    <rect x="12" y="64" width="40" height="132" rx="9" fill="${color}"/>
    <path d="M12 86 h40 M12 176 h40" stroke="rgba(0,0,0,.18)" stroke-width="9"/>
    <rect x="16" y="196" width="32" height="9" rx="4" fill="#2A2622" stroke="none"/>
  </svg>`;
}

/** A rough crayon scribble stroke. */
function scribble(color) {
  return `<svg viewBox="0 0 220 140" fill="none" stroke="${color}" stroke-width="15" stroke-linecap="round" opacity=".65">
    <path d="M12 44 q40 -28 70 4 t70 6 q30 20 56 -6 M18 88 q44 -20 74 8 t72 2"/>
  </svg>`;
}

/** A crayon sun. */
function sun() {
  return `<svg viewBox="0 0 120 120" fill="none" stroke="#F5A623" stroke-width="7" stroke-linecap="round">
    <circle cx="60" cy="60" r="26"/>
    <path d="M60 12v14M60 94v14M12 60h14M94 60h14M26 26l10 10M84 84l10 10M94 26l-10 10M36 84l-10 10"/>
  </svg>`;
}

/** One side of the before/after reveal — an image in a frame, or a labelled placeholder. */
function frame(src, label, kind) {
  const inner = src ? `<img src="${esc(src)}" alt="${esc(label)}">` : `<div class="ph ph-${kind}"><span>${esc(label)}</span></div>`;
  return `<figure class="frame frame-${kind}">${inner}</figure>`;
}

/**
 * Build the ad HTML.
 * @param {object} o
 * @param {'square'|'story'|'wide'} [o.format]
 * @param {'rainbow'|'sunset'|'sky'} [o.palette]
 * @param {string} o.headline   the line before the highlighted word
 * @param {string} o.highlight  the word to mark in the accent colour
 * @param {?string} [o.badge]   optional seasonal badge text
 * @param {?string} [o.beforeSrc] photo src (data: URI or file URL) — an AI marketing image, never a customer's photo
 * @param {?string} [o.afterSrc]  line-art src
 * @param {?string} [o.logoSrc]   the real Fotomalovánky logo as a data URI; falls back to a drawn mark
 * @returns {string} a full self-contained HTML document
 */
export function renderCreativeHtml({ format = 'square', palette = 'rainbow', headline = '', highlight = '', badge = null, beforeSrc = null, afterSrc = null, logoSrc = null } = {}) {
  const F = FORMATS[format] ?? FORMATS.square;
  const pal = PALETTES[palette] ?? PALETTES.rainbow;
  const wide = format === 'wide';
  const story = format === 'story';
  // Story is tall, so the reveal stacks vertically (photo over line-art) to fill the canvas;
  // square/wide keep the side-by-side pair with the dashed seam down the middle.
  const frameW = wide ? 288 : story ? 812 : 366;
  const frameH = wide ? 288 : story ? 520 : 366;
  const headlineSize = wide ? 40 : story ? 74 : 60;

  const badgeHtml = badge
    ? `<div class="badge"><svg class="starburst" viewBox="0 0 120 120" aria-hidden="true"><path fill="#fff" stroke="#2A2622" stroke-width="2.5" d="M60 4l10 14 16-8 3 18 18 3-8 16 14 10-14 10 8 16-18 3-3 18-16-8-10 14-10-14-16 8-3-18-18-3 8-16L4 60l14-10-8-16 18-3 3-18 16 8z"/></svg><span>${esc(badge)}</span></div>`
    : '';
  // The real brand logo (the polaroid + multicolour wordmark lockup) when supplied; the drawn
  // mark is only a fallback for pure/offline use where no image is passed in.
  const logo = logoSrc
    ? `<div class="logo"><img class="logo-img" src="${esc(logoSrc)}" alt="Fotomalovánky"></div>`
    : `<div class="logo">${wide ? '' : logoMark()}<div class="word">${wordmark()}</div></div>`;
  const headlineHtml = `<div class="headline">${esc(headline)} <span class="hi">${esc(highlight)}</span></div>`;
  const reveal = `<div class="reveal${story ? ' stack' : ''}">${frame(beforeSrc, 'fotka', 'before')}${frame(afterSrc, 'omalovánka', 'after')}</div>`;

  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${F.w}px;height:${F.h}px;overflow:hidden}
  .stage{position:relative;width:${F.w}px;height:${F.h}px;overflow:hidden;background:${pal.bg};
    font-family:"Fredoka","Baloo 2",ui-rounded,"Segoe UI",system-ui,sans-serif;color:#2A2622}
  .deco{position:absolute;z-index:1;pointer-events:none}
  .content{position:absolute;inset:0;z-index:2;display:flex;
    ${wide ? 'flex-direction:row;align-items:center;gap:48px;padding:56px 76px;'
           : `flex-direction:column;align-items:center;justify-content:space-between;padding:${story ? '80px 60px 70px' : '72px 60px 62px'};`}}
  .wcol{display:flex;flex-direction:column;gap:30px;align-items:flex-start;flex:1}
  .logo{display:flex;flex-direction:column;align-items:${wide ? 'flex-start' : 'center'};gap:12px}
  .logo .logo-img{width:${wide ? 250 : story ? 348 : 384}px;max-width:76%;height:auto;filter:drop-shadow(0 3px 0 rgba(255,255,255,.55))}
  .logo .mark{width:104px;height:auto}
  .logo .word{font-weight:600;letter-spacing:.5px;font-size:${wide ? 42 : 54}px;line-height:1;text-shadow:0 2px 0 rgba(255,255,255,.55)}
  .reveal{display:flex;background:#fff;border-radius:30px;padding:18px;flex:0 0 auto;box-shadow:0 26px 64px rgba(150,95,60,.20)}
  .reveal.stack{flex-direction:column}
  .reveal .frame{position:relative;margin:0;width:${frameW}px;height:${frameH}px;overflow:hidden}
  .reveal .frame-before{border-radius:18px 0 0 18px;border-right:3px dashed #C9BDB0}
  .reveal .frame-after{border-radius:0 18px 18px 0}
  .reveal.stack .frame-before{border-radius:18px 18px 0 0;border-right:0;border-bottom:3px dashed #C9BDB0}
  .reveal.stack .frame-after{border-radius:0 0 18px 18px}
  .reveal .frame img{width:100%;height:100%;object-fit:cover;display:block}
  .ph{width:100%;height:100%;display:flex;align-items:flex-end;justify-content:center;padding-bottom:18px;
    font-size:16px;font-weight:600;color:#B8A99A;text-transform:uppercase;letter-spacing:.06em}
  .ph-before{background:repeating-linear-gradient(45deg,#F3ECE4,#F3ECE4 14px,#EDE3D8 14px,#EDE3D8 28px)}
  .ph-after{background:#fff}
  .headline{background:#fff;border-radius:34px;padding:${wide ? '22px 32px' : '28px 46px'};text-align:center;
    box-shadow:0 18px 44px rgba(150,95,60,.16);font-weight:600;line-height:1.1;
    font-size:${headlineSize}px;max-width:${wide ? 560 : F.w - 128}px}
  .headline .hi{color:${pal.accent};background:linear-gradient(180deg,transparent 56%,${pal.accent}30 56%,${pal.accent}30 94%,transparent 94%);border-radius:4px;padding:0 .1em;white-space:nowrap}
  .badge{position:absolute;z-index:3;width:${wide ? 170 : 190}px;height:${wide ? 170 : 190}px;
    top:${wide ? 34 : 176}px;${wide ? 'left:70px' : 'right:46px'};transform:rotate(8deg);
    display:flex;align-items:center;justify-content:center;text-align:center}
  .badge .starburst{position:absolute;inset:0;width:100%;height:100%;filter:drop-shadow(0 6px 12px rgba(150,95,60,.22))}
  .badge span{position:relative;font-weight:600;font-size:${wide ? 17 : 19}px;line-height:1.14;padding:0 30px;color:#2A2622}
</style></head><body>
  <div class="stage">
    <div class="deco" style="top:-16px;left:30px;width:${wide ? 60 : 78}px;transform:rotate(-16deg)">${crayon('#3B82F6')}</div>
    <div class="deco" style="top:6px;right:${wide ? 40 : 300}px;width:${wide ? 58 : 74}px;transform:rotate(20deg)">${crayon('#F1543F')}</div>
    <div class="deco" style="bottom:-16px;right:${wide ? 60 : 84}px;width:${wide ? 62 : 84}px;transform:rotate(-8deg)">${crayon('#F5A623')}</div>
    <div class="deco" style="bottom:30px;left:-8px;width:190px">${scribble('#3B82F6')}</div>
    <div class="deco" style="${wide ? 'bottom:44px;right:250px' : 'top:158px;left:44px'};width:100px">${sun()}</div>
    ${badgeHtml}
    <div class="content">
      ${wide ? `<div class="wcol">${logo}${headlineHtml}</div>${reveal}` : `${logo}${reveal}${headlineHtml}`}
    </div>
  </div>
</body></html>`;
}

/** Merge a campaign preset with per-render overrides (photos, format, and any copy tweaks). */
export function creativeFromCampaign(campaignKey, overrides = {}) {
  const c = CAMPAIGNS[campaignKey] ?? CAMPAIGNS.obecny;
  return { format: 'square', palette: c.palette, headline: c.headline, highlight: c.highlight, badge: c.badge, ...overrides };
}
